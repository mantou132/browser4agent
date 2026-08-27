import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

let storage = {};
globalThis.chrome = {
  i18n: {
    getMessage: (key) => key,
  },
  storage: {
    local: {
      get: async (key) => ({ [key]: storage[key] }),
      set: async (patch) => Object.assign(storage, patch),
    },
  },
};

const { agentSessionKey } = await import('../shared/agent-session-store.js');
const { localStorageKeys } = await import('../shared/storage-keys.js');
const { createSessionController } = await import('../pages/agent-panel/session-controller.js');
const { createSessionRuntime, reduceSessionEvent } = await import('../pages/agent-panel/session-runtime.js');
const { createTurnController } = await import('../pages/agent-panel/turn-controller.js');

function createPanelState(patch = {}) {
  const state = (next) => Object.assign(state, next);
  return Object.assign(state, {
    sessions: [],
    draftSession: null,
    defaults: { agent: '', configOptionsByAgent: {} },
    sessionKey: null,
    messages: [],
    configOptions: [],
    queue: [],
    pendingIds: [],
    loadingIds: [],
    deleting: null,
    error: '',
    sessionErrors: {},
    cwd: '',
    newSessionOpen: false,
    permissions: {},
    ...patch,
  });
}

const noopTurns = {
  run() {},
  abort: async () => {},
  decidePermission() {},
  declineAllPermissions() {},
  clearCanceledSessions() {},
};

beforeEach(() => {
  storage = {};
});

describe('agent panel runtime', () => {
  it('reduces streamed chunks, thoughts, and tool updates without losing order', () => {
    let pane = { messages: [], configOptions: [] };
    const apply = (update) => {
      const result = reduceSessionEvent(pane, { event: 'session_update', update });
      if (result?.pane) pane = { ...pane, ...result.pane };
      return result;
    };

    apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } });
    apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } });
    apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Think' } });
    apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ing' } });
    apply({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read' });
    apply({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' });

    assert.deepEqual(
      pane.messages.map((message) => message.type || message.role),
      ['agent', 'thought', 'tool', 'event'],
    );
    assert.equal(pane.messages[0].text, 'Hello world');
    assert.deepEqual(pane.messages[1], { type: 'thought', text: 'Thinking', pending: false });
    assert.equal(pane.messages[2].data.status, 'completed');

    const info = apply({ sessionUpdate: 'session_info_update', title: 'ACP title', updatedAt: '2026-08-26' });
    assert.deepEqual(info.session, { title: 'ACP title', updatedAt: '2026-08-26' });
  });

  it('materializes a draft once and starts its first turn with the ACP title', async () => {
    const state = createPanelState();
    const runtime = createSessionRuntime(state);
    const turns = {
      ...noopTurns,
      calls: [],
      run(...args) {
        this.calls.push(args);
      },
    };
    const controller = createSessionController({
      state,
      runtime,
      turns,
      api: {
        createSession: async () => ({ sessionId: 'acp-1', title: 'ACP title', configOptions: [] }),
        setSessionConfigOption: async () => ({ configOptions: [] }),
        closeSession: async () => true,
      },
    });

    controller.confirmNewSession({ agent: 'codex', cwd: '/repo' });
    await controller.startDraftTurn('draft', { prompt: 'First prompt', attachments: [] });

    const key = agentSessionKey('codex', 'acp-1');
    assert.equal(state.draftSession, null);
    assert.equal(state.sessionKey, key);
    assert.equal(state.sessions[0].title, 'ACP title');
    assert.deepEqual(turns.calls, [[key, { prompt: 'First prompt', attachments: [] }]]);
  });

  it('ignores a stale load after reconnect and allows the session to be loaded again', async () => {
    const key = agentSessionKey('codex', 'acp-1');
    const state = createPanelState({
      sessions: [{ key, agent: 'codex', sessionId: 'acp-1', cwd: '/repo' }],
    });
    const runtime = createSessionRuntime(state);
    let resolveFirstLoad;
    let loadCount = 0;
    const controller = createSessionController({
      state,
      runtime,
      turns: noopTurns,
      api: {
        loadSession: () => {
          loadCount += 1;
          if (loadCount === 1) return new Promise((resolve) => (resolveFirstLoad = resolve));
          return Promise.resolve({ configOptions: [{ id: 'model' }] });
        },
      },
    });

    const staleLoad = controller.openSession(key);
    controller.handleHostReconnect();
    resolveFirstLoad({ configOptions: [{ id: 'stale' }] });
    await staleLoad;

    assert.equal(state.sessionKey, null);
    assert.equal(runtime.hasCachedPane(key), false);

    await controller.openSession(key);
    assert.equal(loadCount, 2);
    assert.equal(state.sessionKey, key);
    assert.deepEqual(state.configOptions, [{ id: 'model' }]);
  });

  it('activates the previous list item when deleting the current session', async () => {
    const previousKey = agentSessionKey('codex', 'previous');
    const currentKey = agentSessionKey('codex', 'current');
    const nextKey = agentSessionKey('codex', 'next');
    const sessions = [
      { key: previousKey, agent: 'codex', sessionId: 'previous' },
      { key: currentKey, agent: 'codex', sessionId: 'current' },
      { key: nextKey, agent: 'codex', sessionId: 'next' },
    ];
    storage[localStorageKeys.agentPanelState] = {
      sessions,
      defaults: { agent: 'codex', configOptionsByAgent: {} },
    };
    const state = createPanelState({ sessions, sessionKey: currentKey });
    const runtime = createSessionRuntime(state);
    runtime.setCachedPane(previousKey, {
      messages: [{ role: 'agent', text: 'Previous session' }],
      configOptions: [],
      cwd: '/previous',
      queue: [],
    });
    const controller = createSessionController({
      state,
      runtime,
      turns: noopTurns,
      api: {
        closeSession: async () => true,
        deleteSession: async () => true,
      },
    });

    await controller.deleteSession(currentKey);

    assert.equal(state.sessionKey, previousKey);
    assert.equal(state.messages[0].text, 'Previous session');
    assert.deepEqual(
      state.sessions.map((session) => session.key),
      [previousKey, nextKey],
    );
  });

  it('keeps queued prompts after cancel instead of auto-draining them', async () => {
    const key = agentSessionKey('codex', 'acp-1');
    const state = createPanelState({
      sessions: [{ key, agent: 'codex', sessionId: 'acp-1', title: 'Session' }],
      sessionKey: key,
    });
    const runtime = createSessionRuntime(state);
    let resolveAsk;
    let askCount = 0;
    const turns = createTurnController({
      state,
      runtime,
      scrollToLatest() {},
      startDraftTurn() {},
      api: {
        ask: () => {
          askCount += 1;
          return new Promise((resolve) => (resolveAsk = resolve));
        },
        cancelPrompt: async () => {
          resolveAsk('partial');
          return true;
        },
      },
    });

    turns.send({ prompt: 'First', attachments: [] });
    turns.send({ prompt: 'Second', attachments: [] });
    assert.equal(state.queue.length, 1);

    await turns.abort(key);

    assert.equal(askCount, 1);
    assert.equal(state.pendingIds.length, 0);
    assert.equal(state.queue[0].prompt, 'Second');
  });
});
