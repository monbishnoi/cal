import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const tempDir = mkdtempSync(join(tmpdir(), 'cal-gateway-test-'));
process.env.CAL_EVENTS_FILE = join(tempDir, 'events.jsonl');
process.env.CAL_HTTP_HOST = '127.0.0.1';
process.env.CAL_HTTP_PORT = '0';

const { eventBus } = await import('./event-bus.js');
const { conversationRuntime } = await import('./conversation-runtime.js');
const { CalSession } = await import('./session.js');
const {
  setSession,
  startHttpServer,
  stopHttpServer,
} = await import('./http-server.js');

function createFakeSession(sessionId = 'test-main') {
  return {
    sessionId,
    messages: [],
    isProcessingMessage: false,
    resetCalled: false,
    getUsageStatus() {
      return {
        thresholdHandoff: false,
        handoffTriggered: false,
        totalTokens: 100,
        contextLimit: 100000,
        percentageFormatted: '0.1%',
      };
    },
    reset() {
      this.resetCalled = true;
      this.messages = [];
    },
    addSteer(text) {
      this.messages.push({ role: 'user', content: `[USER STEERING]: ${text}` });
    },
    async sendMessage(text, options = {}) {
      this.isProcessingMessage = true;
      this.messages.push({ role: 'user', content: text });
      options.onToolCall?.('test_tool', { query: 'runtime smoke' });
      await new Promise(resolve => setTimeout(resolve, 5));
      options.onToolResult?.('test_tool', false);
      const response = `Echo: ${text}`;
      this.messages.push({ role: 'assistant', content: [{ type: 'text', text: response }] });
      this.isProcessingMessage = false;
      return {
        text: response,
        usageStatus: this.getUsageStatus(),
      };
    },
  };
}

function createSteerBoundarySession() {
  const calls = [];
  const session = Object.create(CalSession.prototype);

  Object.assign(session, {
    sessionId: 'steer-boundary-test',
    messages: [{ role: 'user', content: 'original request' }],
    steerQueue: [],
    model: 'test-model',
    systemPrompt: 'test-system',
    tokenUsage: { inputTokens: 0, outputTokens: 0, lastUpdated: null },
    client: {
      messages: {
        create: async (payload) => {
          calls.push(JSON.parse(JSON.stringify(payload.messages)));
          return {
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    },
  });

  return { session, calls };
}

async function testSteersDrainBeforeEveryModelCall() {
  const { session, calls } = createSteerBoundarySession();

  session.addSteer('first steer');
  await session.callClaude();

  assert.equal(session.steerQueue.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1).content, '[USER STEERING]: first steer');

  session.addSteer('second steer');
  session.addSteer('third steer');
  await session.callClaude();

  assert.equal(session.steerQueue.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].at(-1).content, '[USER STEERING]: second steer\nthird steer');

  await session.callClaude();

  assert.equal(calls.length, 3);
  assert.equal(
    calls[2].filter(msg => typeof msg.content === 'string' && msg.content.startsWith('[USER STEERING]:')).length,
    2
  );
}

async function testConversationRuntimeEvents() {
  const events = [];
  const unsubscribe = eventBus.subscribeAll(event => events.push(event));
  const session = createFakeSession('runtime-test');

  const result = await conversationRuntime.handleUserMessage({
    source: 'pwa',
    text: 'hello runtime',
    session,
    handleCommands: false,
  });

  unsubscribe();

  assert.equal(result.text, 'Echo: hello runtime');
  assert.deepEqual(
    events.map(event => event.type),
    [
      'message_received',
      'run_started',
      'status_changed',
      'tool_call_started',
      'tool_call_finished',
      'response_complete',
      'run_finished',
      'status_changed',
    ]
  );
  assert.equal(events[0].seq + 1, events[1].seq);
  assert.equal(events[2].payload.state, 'processing');
  assert.equal(events.at(-1).payload.state, 'idle');
}

async function testCommandDoesNotCallModel() {
  let sendCalled = false;
  const session = createFakeSession('command-test');
  session.sendMessage = async () => {
    sendCalled = true;
    throw new Error('sendMessage should not be called for /status');
  };

  const result = await conversationRuntime.handleUserMessage({
    source: 'pwa',
    text: '/status',
    session,
  });

  assert.equal(sendCalled, false);
  assert.match(result.text, /Cal Gateway/);
  assert.match(result.text, /Session: command-test/);
}

async function waitForWsMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 2000);
    ws.once('message', raw => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

async function testHttpWebSocketEndToEnd() {
  const session = createFakeSession('http-test');
  setSession(session);
  const server = await startHttpServer();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const initialMessage = waitForWsMessage(ws);

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const initial = await initialMessage;
    assert.deepEqual(initial, { type: 'status', state: 'idle' });

    const received = [];
    ws.on('message', raw => {
      received.push(JSON.parse(raw.toString()));
    });

    ws.send(JSON.stringify({ type: 'message', text: 'hello websocket' }));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for runtime WebSocket events')), 3000);
      ws.on('message', () => {
        const hasText = received.some(msg => msg.type === 'text_done' && msg.fullText === 'Echo: hello websocket');
        const idleAfterText = received.findIndex(msg => msg.type === 'text_done') !== -1 &&
          received.slice(received.findIndex(msg => msg.type === 'text_done')).some(msg => msg.type === 'status' && msg.state === 'idle');
        if (hasText && idleAfterText) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    assert(received.some(msg => msg.type === 'run_started'));
    assert(received.some(msg => msg.type === 'status' && msg.state === 'processing'));
    assert(received.some(msg => msg.type === 'step_started' && msg.tool === 'test_tool'));
    assert(received.some(msg => msg.type === 'step_finished' && msg.tool === 'test_tool'));
  } finally {
    ws.close();
    stopHttpServer();
  }
}

try {
  await testSteersDrainBeforeEveryModelCall();
  await testConversationRuntimeEvents();
  await testCommandDoesNotCallModel();
  await testHttpWebSocketEndToEnd();
  console.log('All Cal Gateway tests passed');
} finally {
  stopHttpServer();
  rmSync(tempDir, { recursive: true, force: true });
}
