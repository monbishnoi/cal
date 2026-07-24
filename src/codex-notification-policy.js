import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './paths.js';

export const CODEX_NOTIFICATION_MODES = {
  ASK_ME: 'ask-me',
  DONT_ASK_ME: 'dont-ask-me',
};

const DEFAULT_STATE = Object.freeze({
  mode: CODEX_NOTIFICATION_MODES.ASK_ME,
  pendingMode: null,
  updatedAt: null,
});

const DEFAULT_STATE_PATH = path.join(DATA_DIR, 'codex-notification-policy.json');
let statePathForTest = null;
let cachedState = null;

function getStatePath() {
  return statePathForTest || DEFAULT_STATE_PATH;
}

function normalizeState(value = {}) {
  const mode = value.mode === CODEX_NOTIFICATION_MODES.DONT_ASK_ME
    ? CODEX_NOTIFICATION_MODES.DONT_ASK_ME
    : CODEX_NOTIFICATION_MODES.ASK_ME;
  const pendingMode = value.pendingMode === CODEX_NOTIFICATION_MODES.DONT_ASK_ME
    ? CODEX_NOTIFICATION_MODES.DONT_ASK_ME
    : null;

  return {
    mode,
    pendingMode,
    updatedAt: value.updatedAt || null,
  };
}

function loadState() {
  if (cachedState) return cachedState;

  try {
    const raw = fs.readFileSync(getStatePath(), 'utf8');
    cachedState = normalizeState(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[Codex Policy] Could not load notification mode: ${err.message}`);
    }
    cachedState = { ...DEFAULT_STATE };
  }

  return cachedState;
}

function saveState(nextState) {
  const filePath = getStatePath();
  const normalized = {
    ...normalizeState(nextState),
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
  cachedState = normalized;
  return { ...cachedState };
}

export function getCodexNotificationPolicy() {
  return { ...loadState() };
}

export function requestCodexNotificationMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  const current = loadState();

  if (normalized === CODEX_NOTIFICATION_MODES.ASK_ME) {
    saveState({
      mode: CODEX_NOTIFICATION_MODES.ASK_ME,
      pendingMode: null,
    });
    return {
      changed: current.mode !== CODEX_NOTIFICATION_MODES.ASK_ME,
      needsConfirmation: false,
      mode: CODEX_NOTIFICATION_MODES.ASK_ME,
      message: 'Codex notification mode is now ask-me. I will draft answers and wait for your approval.',
    };
  }

  if (normalized !== CODEX_NOTIFICATION_MODES.DONT_ASK_ME) {
    return {
      changed: false,
      needsConfirmation: false,
      mode: current.mode,
      error: 'Mode must be ask-me or dont-ask-me.',
      message: 'Mode must be ask-me or dont-ask-me.',
    };
  }

  if (current.mode === CODEX_NOTIFICATION_MODES.DONT_ASK_ME && !current.pendingMode) {
    return {
      changed: false,
      needsConfirmation: false,
      mode: current.mode,
      message: 'Codex notification mode is already dont-ask-me.',
    };
  }

  saveState({
    mode: current.mode,
    pendingMode: CODEX_NOTIFICATION_MODES.DONT_ASK_ME,
  });
  return {
    changed: false,
    needsConfirmation: true,
    mode: current.mode,
    pendingMode: CODEX_NOTIFICATION_MODES.DONT_ASK_ME,
    message: 'Confirming: I will answer Codex questions on Cal-initiated tasks without checking with you, for up to three cycles, until you switch back to ask-me. Yes?',
  };
}

export function confirmCodexNotificationMode(approved) {
  const current = loadState();
  if (!current.pendingMode) {
    return {
      changed: false,
      needsConfirmation: false,
      mode: current.mode,
      message: 'There is no pending Codex notification mode change.',
    };
  }

  if (!approved) {
    saveState({
      mode: current.mode,
      pendingMode: null,
    });
    return {
      changed: false,
      needsConfirmation: false,
      mode: current.mode,
      message: `Mode change cancelled. Codex notification mode remains ${current.mode}.`,
    };
  }

  const mode = current.pendingMode;
  saveState({ mode, pendingMode: null });
  return {
    changed: current.mode !== mode,
    needsConfirmation: false,
    mode,
    message: 'Codex notification mode is now dont-ask-me. I will handle Codex questions automatically for up to three cycles.',
  };
}

export function handleCodexNotificationPolicyInput(text) {
  const normalized = String(text || '').trim().toLowerCase();

  if (normalized === '/ask-me') {
    return requestCodexNotificationMode(CODEX_NOTIFICATION_MODES.ASK_ME);
  }
  if (normalized === '/dont-ask-me') {
    return requestCodexNotificationMode(CODEX_NOTIFICATION_MODES.DONT_ASK_ME);
  }

  if (!loadState().pendingMode) return null;

  if (/^(yes|y|confirm|confirmed|approve|approved)$/.test(normalized)) {
    return confirmCodexNotificationMode(true);
  }
  if (/^(no|n|cancel|never mind|nevermind)$/.test(normalized)) {
    return confirmCodexNotificationMode(false);
  }

  return null;
}

export function __setCodexNotificationPolicyPathForTest(filePath) {
  statePathForTest = filePath || null;
  cachedState = null;
}

export function __resetCodexNotificationPolicyForTest() {
  statePathForTest = null;
  cachedState = null;
}
