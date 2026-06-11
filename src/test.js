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
  setSessionManager,
  startHttpServer,
  stopHttpServer,
} = await import('./http-server.js');
const { SessionManager, setActiveSessionManager } = await import('./session-manager.js');
const { getTools, executeToolCall } = await import('./tools.js');

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

function createToolSession(sessionId, messages = []) {
  return {
    sessionId,
    messages: [...messages],
    steerQueue: [],
    isProcessingMessage: false,
    addSteer(text) {
      this.steerQueue.push(text);
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

    const observerResponse = await fetch(`http://127.0.0.1:${port}/api/observer/sessions`);
    assert.equal(observerResponse.status, 200);
    const observerBody = await observerResponse.json();
    assert.equal(observerBody.enabled, false);
    assert.equal(observerBody.sessions.length, 1);
    assert.equal(observerBody.sessions[0].sessionId, 'http-test');
  } finally {
    ws.close();
    stopHttpServer();
  }
}

async function testMultiSessionEndpoints() {
  process.env.MULTI_SESSION_ENABLED = 'true';
  const session = createFakeSession('multi-home');
  const manager = new SessionManager({ homeSession: session });
  setSession(session);
  setSessionManager(manager);

  const server = await startHttpServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const initial = await fetch(`${base}/api/sessions`);
    assert.equal(initial.status, 200);
    const initialBody = await initial.json();
    assert.equal(initialBody.sessions.length, 1);
    assert.equal(initialBody.sessions[0].name, 'Cal');

    const created = [];
    for (const expectedName of ['Strand', 'Strand 2', 'Strand 3']) {
      const response = await fetch(`${base}/api/sessions`, { method: 'POST' });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.session.name, expectedName);
      assert.equal(body.session.permanent, false);
      created.push(body.session);
    }

    const tooMany = await fetch(`${base}/api/sessions`, { method: 'POST' });
    assert.equal(tooMany.status, 409);

    const deleted = await fetch(`${base}/api/sessions/${created[0].sessionId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const deletedBody = await deleted.json();
    assert.equal(deletedBody.closed, true);
    assert.equal(deletedBody.sessions.length, 3);

    const staleMessage = await fetch(`${base}/api/sessions/${created[0].sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message: 'hello missing strand' }),
    });
    assert.equal(staleMessage.status, 404);
    const staleBody = await staleMessage.json();
    assert.match(staleBody.error, /^Unknown session:/);
    assert.equal(staleBody.staleSession, true);
    assert.equal(staleBody.sessions.some(item => item.sessionId === created[0].sessionId), false);
    assert.equal(staleBody.sessions.length, 3);

    const observerResponse = await fetch(`${base}/api/observer/sessions`);
    assert.equal(observerResponse.status, 200);
    const observerBody = await observerResponse.json();
    assert.equal(observerBody.enabled, true);
    assert.deepEqual(observerBody.sessions.map(item => item.sessionId), [
      'multi-home',
      created[1].sessionId,
      created[2].sessionId,
    ]);
    assert(observerBody.sessions.every(item => typeof item.sessionId === 'string'));
    assert(observerBody.sessions.every(item => !('runtime' in item)));
  } finally {
    stopHttpServer();
    setSessionManager(null);
    setActiveSessionManager(null);
    process.env.MULTI_SESSION_ENABLED = '';
  }
}

async function testMultiSessionWebSocketTags() {
  process.env.MULTI_SESSION_ENABLED = 'true';
  const session = createFakeSession('multi-ws-home');
  const manager = new SessionManager({ homeSession: session });
  setSession(session);
  setSessionManager(manager);

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
    assert.deepEqual(initial, { type: 'status', sessionId: 'multi-ws-home', state: 'idle' });

    const received = [];
    ws.on('message', raw => {
      received.push(JSON.parse(raw.toString()));
    });

    ws.send(JSON.stringify({ type: 'message', sessionId: 'multi-ws-home', text: 'hello tagged websocket' }));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for tagged WebSocket events')), 3000);
      ws.on('message', () => {
        const hasText = received.some(msg =>
          msg.type === 'text_done' &&
          msg.sessionId === 'multi-ws-home' &&
          msg.fullText === 'Echo: hello tagged websocket'
        );
        if (hasText) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } finally {
    ws.close();
    stopHttpServer();
    setSessionManager(null);
    setActiveSessionManager(null);
    process.env.MULTI_SESSION_ENABLED = '';
  }
}

async function testMultiSessionUnknownWebSocketSessionRecovery() {
  process.env.MULTI_SESSION_ENABLED = 'true';
  const session = createFakeSession('multi-ws-recovery-home');
  const manager = new SessionManager({ homeSession: session });
  setSession(session);
  setSessionManager(manager);

  const server = await startHttpServer();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const initialMessage = waitForWsMessage(ws);

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    await initialMessage;
    ws.send(JSON.stringify({ type: 'message', sessionId: 'missing-strand', text: 'hello missing websocket strand' }));

    const errorMessage = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for stale session error')), 2000);
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'run_error' && msg.sessionId === 'missing-strand') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });

    assert.equal(errorMessage.error, 'No active session');
    assert.equal(errorMessage.staleSession, true);
    assert.deepEqual(errorMessage.sessions.map(item => item.sessionId), ['multi-ws-recovery-home']);
  } finally {
    ws.close();
    stopHttpServer();
    setSessionManager(null);
    setActiveSessionManager(null);
    process.env.MULTI_SESSION_ENABLED = '';
  }
}

async function testCrossSessionToolsRegistrationAndExecution() {
  const previousFlag = process.env.MULTI_SESSION_ENABLED;
  try {
    process.env.MULTI_SESSION_ENABLED = '';
    assert.equal(getTools({ includeMCP: false }).some(tool => tool.name === 'inject_context'), false);
    assert.equal(getTools({ includeMCP: false }).some(tool => tool.name === 'search_session'), false);

    process.env.MULTI_SESSION_ENABLED = 'true';
    const home = createToolSession('tool-home');
    const strand = createToolSession('tool-strand', [
      { role: 'user', content: 'Discuss the visa letter draft' },
      { role: 'assistant', content: [{ type: 'text', text: 'We should keep it concise.' }] },
      { role: 'user', content: 'Add salary confirmation details' },
      { role: 'assistant', content: 'Done.' },
    ]);

    const manager = new SessionManager({ homeSession: home });
    manager.sessions.set('tool-strand', {
      sessionId: 'tool-strand',
      name: 'Strand',
      runtime: strand,
      status: 'ready',
      createdAt: Date.now(),
      permanent: false,
    });

    const enabledTools = getTools({ includeMCP: false }).map(tool => tool.name);
    assert(enabledTools.includes('inject_context'));
    assert(enabledTools.includes('search_session'));

    const injected = await executeToolCall('inject_context', {
      target: 'Strand',
      context: 'Please use the short agency version.',
    });
    assert.equal(injected, 'Injected context into Strand.');
    assert.equal(strand.steerQueue.length, 1);
    assert.match(strand.steerQueue[0], /Please use the short agency version/);

    const searchResult = await executeToolCall('search_session', {
      target: 'Strand',
      query: 'salary',
    });
    const parsed = JSON.parse(searchResult);
    assert.equal(parsed.name, 'Strand');
    assert.equal(parsed.resultCount, 1);
    assert.match(parsed.results[0].content, /salary confirmation/);

    const recentResult = JSON.parse(await executeToolCall('search_session', {
      target: 'Strand',
    }));
    assert.equal(recentResult.resultCount, 4);

    const missing = await executeToolCall('search_session', {
      target: 'Strand 9',
      query: 'visa',
    });
    assert.match(missing, /^Error: No active session found/);
  } finally {
    setActiveSessionManager(null);
    process.env.MULTI_SESSION_ENABLED = previousFlag || '';
  }
}

try {
  await testSteersDrainBeforeEveryModelCall();
  await testConversationRuntimeEvents();
  await testCommandDoesNotCallModel();
  await testHttpWebSocketEndToEnd();
  await testMultiSessionEndpoints();
  await testMultiSessionWebSocketTags();
  await testMultiSessionUnknownWebSocketSessionRecovery();
  await testCrossSessionToolsRegistrationAndExecution();
  console.log('All Cal Gateway tests passed');
} finally {
  stopHttpServer();
  rmSync(tempDir, { recursive: true, force: true });
}
