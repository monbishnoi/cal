# Voice Mode with Talkbox

Cal can expose its PWA as a voice interface through a separately running [Talkbox](https://github.com/monbishnoi/talkbox) runtime.

The ownership boundary stays explicit:

- Cal owns identity, memory, tools, sessions, and task answers.
- OpenAI Realtime owns speech recognition, turn detection, and synthesized voice.
- Talkbox supplies session configuration, persona policy, agent-tool boundaries, context hydration, and progress narration policy.
- The Cal PWA owns the microphone, playback, visualizer, and direct WebRTC data channel.

## Setup

1. Install and configure Talkbox using its README.
2. Start Talkbox, normally on `http://localhost:8090`.
3. Add `TALKBOX_URL=http://localhost:8090` to `config/.env`.
4. Start Cal and open its PWA.
5. Select the microphone button.

The Cal Gateway proxies session setup, agent calls, progress events, history, context, benchmarks, and transcript writeback through `/voice/*`. API credentials stay in the Talkbox runtime; they are never sent to the browser.

Voice mode is optional. Text chat, images, WebSocket updates, scheduled jobs, and other channels continue to work without Talkbox.
