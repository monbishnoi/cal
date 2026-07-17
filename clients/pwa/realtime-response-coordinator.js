(function installRealtimeResponseCoordinator(global) {
  const DEFAULT_TIMEOUT_MS = 8000;
  const DEFAULT_CANCEL_GRACE_MS = 1500;

  function defaultId() {
    return global.crypto?.randomUUID?.() || `cal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  global.createRealtimeResponseCoordinator = function createRealtimeResponseCoordinator({
    sendEvent,
    onLifecycle = () => {},
    makeId = defaultId,
    setTimer = global.setTimeout,
    clearTimer = global.clearTimeout,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cancelGraceMs = DEFAULT_CANCEL_GRACE_MS,
  } = {}) {
    let active = null;
    const queue = [];

    function detail(record) {
      return record ? {
        phase: record.phase,
        callId: record.callId,
        responseId: record.responseId,
        logicalDone: record.logicalDone,
        audioStopped: record.audioStopped,
      } : {};
    }

    function clearTimers(record) {
      if (record?.timeoutHandle) clearTimer(record.timeoutHandle);
      if (record?.cancelGraceHandle) clearTimer(record.cancelGraceHandle);
    }

    function drain() {
      if (active || queue.length === 0) return;
      send(queue.shift());
    }

    function finish(reason) {
      if (!active) return;
      const finished = active;
      clearTimers(finished);
      active = null;
      onLifecycle('finished', { ...detail(finished), reason });
      drain();
    }

    function startWatchdog(record) {
      if (record.timeoutHandle) return;
      record.timeoutHandle = setTimer(() => {
        if (active !== record) return;
        onLifecycle('timeout', detail(record));
        try {
          sendEvent({
            type: 'response.cancel',
            ...(record.responseId ? { response_id: record.responseId } : {}),
          });
        } catch {}
        record.cancelGraceHandle = setTimer(() => {
          if (active !== record) return;
          onLifecycle('forced_release', detail(record));
          finish('cancel_grace_elapsed');
        }, cancelGraceMs);
      }, timeoutMs);
    }

    function send(record) {
      active = record;
      sendEvent({
        type: 'response.create',
        event_id: record.eventId,
        response: {
          ...record.response,
          metadata: {
            ...(record.response.metadata || {}),
            cal_voice_phase: record.phase,
            cal_voice_call_id: record.callId || '',
          },
        },
      });
      if (record.waitForAudioStop) startWatchdog(record);
      onLifecycle('sent', detail(record));
    }

    function request({ phase, callId = '', response = {}, waitForAudioStop = false }) {
      const record = {
        phase,
        callId,
        response,
        waitForAudioStop,
        eventId: `cal-${makeId()}`,
        responseId: '',
        logicalDone: false,
        audioStopped: false,
        timeoutHandle: null,
        cancelGraceHandle: null,
      };
      queue.push(record);
      onLifecycle('queued', detail(record));
      drain();
      return record.eventId;
    }

    function metadataMatches(record, response = {}) {
      const metadata = response.metadata || {};
      return metadata.cal_voice_phase === record.phase
        && String(metadata.cal_voice_call_id || '') === record.callId;
    }

    function handleResponseCreated(response = {}) {
      if (active && metadataMatches(active, response)) {
        active.responseId = response.id || active.responseId;
        onLifecycle('created', detail(active));
        return;
      }
      if (active) return;
      active = {
        phase: 'server',
        callId: '',
        response: {},
        waitForAudioStop: false,
        eventId: '',
        responseId: response.id || '',
        logicalDone: false,
        audioStopped: false,
        timeoutHandle: null,
        cancelGraceHandle: null,
      };
      onLifecycle('created', detail(active));
    }

    function handleError(error = {}) {
      if (!active?.eventId || error.event_id !== active.eventId) return;
      onLifecycle('error', {
        ...detail(active),
        errorType: error.type || '',
        errorCode: error.code || '',
      });
      finish('response_error');
    }

    function requireActiveAudioStop(responseId = '') {
      if (!active || (active.responseId && responseId && active.responseId !== responseId)) return;
      if (!active.responseId && responseId) active.responseId = responseId;
      active.waitForAudioStop = true;
      startWatchdog(active);
      onLifecycle('audio_gate_required', detail(active));
    }

    function handleResponseDone(response = {}) {
      if (!active) return;
      if (active.responseId && response.id && active.responseId !== response.id) return;
      if (active.phase !== 'server' && !active.responseId && !metadataMatches(active, response)) return;
      active.responseId = response.id || active.responseId;
      active.logicalDone = true;
      onLifecycle('done', detail(active));
      if (!active.waitForAudioStop || active.audioStopped) finish('response_done');
    }

    function handleAudioStopped(responseId = '') {
      if (!active || !active.waitForAudioStop) return;
      if (active.responseId && responseId && active.responseId !== responseId) return;
      if (!active.responseId && responseId) active.responseId = responseId;
      active.audioStopped = true;
      onLifecycle('audio_stopped', detail(active));
      if (active.logicalDone) finish('audio_stopped');
    }

    function reset() {
      clearTimers(active);
      active = null;
      for (const record of queue) clearTimers(record);
      queue.length = 0;
    }

    return {
      request,
      handleResponseCreated,
      handleError,
      requireActiveAudioStop,
      handleResponseDone,
      handleAudioStopped,
      reset,
      snapshot: () => ({ active: detail(active), queued: queue.map(detail) }),
    };
  };
}(globalThis));
