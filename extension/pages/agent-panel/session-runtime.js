import { removeStoredSession, updateAgentPanelState, upsertStoredSession } from '../../shared/agent-session-store.js';
import { t } from '../../shared/i18n.js';

export const DRAFT_SESSION_KEY = 'draft';
const CLAUDE_INTERRUPTED_USER_MESSAGE = '[Request interrupted by user]';

/** Keep the `mode` config option in sync with a `current_mode_update`. */
export function withCurrentMode(configOptions, currentModeId) {
  return configOptions.map((option) => (option.id === 'mode' ? { ...option, currentValue: currentModeId } : option));
}

/** Keep one config option in sync with a locally staged change. */
export function withConfigValue(configOptions, configId, value) {
  return configOptions.map((option) => (option.id === configId ? { ...option, currentValue: value } : option));
}

export function withAgentConfigOptions(state, agent, configOptions) {
  return {
    ...state,
    defaults: {
      ...state.defaults,
      configOptionsByAgent: {
        ...state.defaults.configOptionsByAgent,
        [agent]: configOptions,
      },
    },
  };
}

/** Append a streaming chunk to the last matching message, else start a new one. */
function appendChunk(messages, match, make) {
  const next = messages.slice();
  const last = next.at(-1);
  if (match(last)) {
    next[next.length - 1] = make(last);
  } else {
    next.push(make(null));
  }
  return next;
}

export function completeThought(messages) {
  const last = messages.at(-1);
  if (last?.type !== 'thought' || !last.pending) return messages;
  const next = messages.slice();
  next[next.length - 1] = { ...last, pending: false };
  return next;
}

/** Convert one streamed ACP event into local pane and session-index patches. */
export function reduceSessionEvent(state, event, { agent } = {}) {
  const messages = state?.messages ?? [];
  if (event.event !== 'session_update') {
    if (event.event !== 'stop') return null;
    const completed = completeThought(messages);
    return completed === messages ? null : { pane: { messages: completed } };
  }

  const { update } = event;
  const thoughtChunk = update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text';
  const currentMessages = thoughtChunk ? messages : completeThought(messages);
  const role =
    update.sessionUpdate === 'agent_message_chunk'
      ? 'agent'
      : update.sessionUpdate === 'user_message_chunk'
        ? 'user'
        : null;

  if (role && update.content?.type === 'text') {
    if (agent === 'claude' && role === 'user' && update.content.text.trim() === CLAUDE_INTERRUPTED_USER_MESSAGE) {
      return currentMessages === messages ? null : { pane: { messages: currentMessages } };
    }
    return {
      pane: {
        messages: appendChunk(
          currentMessages,
          (last) => last?.role === role,
          (last) => (last ? { ...last, text: last.text + update.content.text } : { role, text: update.content.text }),
        ),
      },
    };
  }

  if (role && update.content?.type === 'image' && update.content.data) {
    const { mimeType = 'image/png', data } = update.content;
    const attachment = {
      id: crypto.randomUUID(),
      kind: 'image',
      name: t('devtoolsPanelImageAttachment'),
      mimeType,
      previewUrl: `data:${mimeType};base64,${data}`,
    };
    return {
      pane: {
        messages: appendChunk(
          currentMessages,
          (last) => last?.role === role,
          (last) =>
            last
              ? { ...last, attachments: [...(last.attachments || []), attachment] }
              : { role, text: '', attachments: [attachment] },
        ),
      },
    };
  }

  if (thoughtChunk) {
    return {
      pane: {
        messages: appendChunk(
          currentMessages,
          (last) => last?.type === 'thought',
          (last) =>
            last
              ? { ...last, text: last.text + update.content.text, pending: true }
              : { type: 'thought', text: update.content.text, pending: true },
        ),
      },
    };
  }

  if (update.sessionUpdate === 'tool_call') {
    return { pane: { messages: [...currentMessages, { type: 'tool', data: update }] } };
  }

  if (update.sessionUpdate === 'tool_call_update') {
    const next = currentMessages.slice();
    const index = next.findLastIndex(
      (message) => message.type === 'tool' && message.data.toolCallId === update.toolCallId,
    );
    if (index === -1) {
      next.push({ type: 'tool', data: update });
    } else {
      next[index] = {
        ...next[index],
        data: { ...next[index].data, ...update, sessionUpdate: 'tool_call' },
      };
    }
    next.push({ type: 'event', data: update });
    return { pane: { messages: next } };
  }

  if (update.sessionUpdate === 'current_mode_update') {
    return { pane: { configOptions: withCurrentMode(state?.configOptions ?? [], update.currentModeId) } };
  }

  if (update.sessionUpdate === 'config_option_update') {
    return { pane: { configOptions: Array.isArray(update.configOptions) ? update.configOptions : [] } };
  }

  if (update.sessionUpdate === 'session_info_update') {
    const session = {};
    if (typeof update.title === 'string' && update.title) session.title = update.title;
    if (typeof update.updatedAt === 'string' && update.updatedAt) session.updatedAt = update.updatedAt;
    return Object.keys(session).length ? { session } : null;
  }

  return { pane: { messages: [...currentMessages, { type: 'event', data: update }] } };
}

/** State access shared by session and turn controllers. It owns the pane cache
 * but not any ACP request lifecycle. */
export function createSessionRuntime(state) {
  const paneCache = new Map();

  const record = (sessionKey) =>
    state.draftSession?.key === sessionKey
      ? state.draftSession
      : state.sessions.find((session) => session.key === sessionKey);

  const list = () => (state.draftSession ? [state.draftSession, ...state.sessions] : state.sessions);

  const target = (sessionKey) => {
    const session = record(sessionKey);
    return session?.sessionId ? { agent: session.agent, sessionId: session.sessionId } : null;
  };

  const getPane = (sessionKey) => (sessionKey === state.sessionKey ? state : paneCache.get(sessionKey));

  const setPane = (sessionKey, patch) => {
    if (sessionKey === state.sessionKey) {
      state(patch);
    } else if (paneCache.has(sessionKey)) {
      paneCache.set(sessionKey, { ...paneCache.get(sessionKey), ...patch });
    }
  };

  const showPane = (sessionKey, pane, patch) => {
    state({
      sessionKey,
      messages: pane.messages,
      configOptions: pane.configOptions,
      queue: pane.queue,
      cwd: pane.cwd,
      ...patch,
    });
  };

  const snapshotCurrent = () => {
    if (!state.sessionKey) return;
    paneCache.set(state.sessionKey, {
      messages: completeThought(state.messages),
      configOptions: state.configOptions,
      cwd: state.cwd,
      queue: state.queue,
    });
  };

  const setSessionFlag = (field, sessionKey, enabled) => {
    const ids = state[field].filter((key) => key !== sessionKey);
    if (enabled) ids.push(sessionKey);
    state({ [field]: ids });
  };

  const setError = (sessionKey, message) => {
    if (!sessionKey) {
      state({ error: message });
      return;
    }
    state({ sessionErrors: { ...state.sessionErrors, [sessionKey]: message } });
  };

  const clearError = (sessionKey) => {
    if (!sessionKey || !state.sessionErrors[sessionKey]) return;
    const sessionErrors = { ...state.sessionErrors };
    delete sessionErrors[sessionKey];
    state({ sessionErrors });
  };

  const mutateStoredState = async (update) => {
    const local = update({ sessions: state.sessions, defaults: state.defaults });
    state({ sessions: local.sessions, defaults: local.defaults });
    try {
      const stored = await updateAgentPanelState(update);
      state({ sessions: stored.sessions, defaults: stored.defaults });
    } catch (e) {
      state({ error: e.message });
    }
  };

  const patchRecord = (sessionKey, patch) => {
    if (!state.sessions.some((session) => session.key === sessionKey)) return Promise.resolve();
    return mutateStoredState((storedState) => {
      const stored = storedState.sessions.find((session) => session.key === sessionKey);
      return stored ? upsertStoredSession(storedState, { ...stored, ...patch }) : storedState;
    });
  };

  const finishThought = (sessionKey) => {
    const pane = getPane(sessionKey);
    const messages = completeThought(pane?.messages ?? []);
    if (messages !== pane?.messages) setPane(sessionKey, { messages });
  };

  const applyEvent = (sessionKey, event) => {
    const result = reduceSessionEvent(getPane(sessionKey), event, { agent: record(sessionKey)?.agent });
    if (result?.pane) setPane(sessionKey, result.pane);
    if (result?.session) patchRecord(sessionKey, result.session);
  };

  const resetPanesForReconnect = () => {
    const draftPane = state.draftSession && paneCache.get(DRAFT_SESSION_KEY);
    const draftLoading = Boolean(draftPane && state.loadingIds.includes(DRAFT_SESSION_KEY));
    paneCache.clear();
    if (draftPane) paneCache.set(DRAFT_SESSION_KEY, draftPane);
    return draftLoading;
  };

  return {
    record,
    list,
    target,
    getPane,
    setPane,
    showPane,
    snapshotCurrent,
    hasCachedPane: (sessionKey) => paneCache.has(sessionKey),
    getCachedPane: (sessionKey) => paneCache.get(sessionKey),
    setCachedPane: (sessionKey, pane) => paneCache.set(sessionKey, pane),
    deletePane: (sessionKey) => paneCache.delete(sessionKey),
    resetPanesForReconnect,
    setLoading: (sessionKey, loading) => setSessionFlag('loadingIds', sessionKey, loading),
    setPending: (sessionKey, pending) => setSessionFlag('pendingIds', sessionKey, pending),
    setError,
    clearError,
    mutateStoredState,
    patchRecord,
    removeRecord: (sessionKey) => mutateStoredState((storedState) => removeStoredSession(storedState, sessionKey)),
    persistAgentDefault: (agent) =>
      mutateStoredState((storedState) => ({
        ...storedState,
        defaults: { ...storedState.defaults, agent },
      })),
    persistConfigOptions: (agent, configOptions) =>
      mutateStoredState((storedState) => withAgentConfigOptions(storedState, agent, configOptions)),
    finishThought,
    applyEvent,
  };
}
