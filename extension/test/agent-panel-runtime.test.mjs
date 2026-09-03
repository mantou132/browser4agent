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

  it('filters Claude Code cancellation markers without hiding other user messages', () => {
    const state = { messages: [], configOptions: [] };
    const interrupted = {
      event: 'session_update',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '[Request interrupted by user]' },
      },
    };

    assert.equal(reduceSessionEvent(state, interrupted, { agent: 'claude' }), null);
    assert.deepEqual(reduceSessionEvent(state, interrupted, { agent: 'codex' })?.pane.messages, [
      { role: 'user', text: '[Request interrupted by user]' },
    ]);
    assert.deepEqual(
      reduceSessionEvent(
        state,
        {
          event: 'session_update',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Why did Claude show [Request interrupted by user]?' },
          },
        },
        { agent: 'claude' },
      )?.pane.messages,
      [{ role: 'user', text: 'Why did Claude show [Request interrupted by user]?' }],
    );
  });

  it('shows a draft prompt immediately and keeps responding while the ACP session is created', async () => {
    const state = createPanelState();
    const runtime = createSessionRuntime(state);
    let resolveCreate;
    const askCalls = [];
    const api = {
      createSession: () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
      setSessionConfigOption: async () => ({ configOptions: [] }),
      closeSession: async () => true,
      ask: (prompt) =>
        new Promise((resolve) => {
          askCalls.push({ prompt, resolve });
        }),
    };
    let controller;
    const turns = createTurnController({
      state,
      runtime,
      api,
      scrollToLatest() {},
      startDraftTurn: (...args) => controller.startDraftTurn(...args),
    });
    controller = createSessionController({ state, runtime, turns, api });

    controller.confirmNewSession({ agent: 'codex', cwd: '/repo' });
    const starting = turns.send({ prompt: 'First prompt', attachments: [] });

    assert.equal(state.sessionKey, 'draft');
    assert.deepEqual(state.messages, [{ role: 'user', text: 'First prompt', attachments: [] }]);
    assert.deepEqual(state.pendingIds, ['draft']);
    assert.deepEqual(state.loadingIds, ['draft']);

    turns.send({ prompt: 'Queued while creating', attachments: [] });
    assert.equal(state.queue[0].prompt, 'Queued while creating');

    resolveCreate({ sessionId: 'acp-1', title: 'ACP title', configOptions: [] });
    await starting;

    const key = agentSessionKey('codex', 'acp-1');
    assert.equal(state.draftSession, null);
    assert.equal(state.sessionKey, key);
    assert.equal(state.sessions[0].title, 'ACP title');
    assert.deepEqual(state.messages, [{ role: 'user', text: 'First prompt', attachments: [] }]);
    assert.deepEqual(state.pendingIds, [key]);
    assert.deepEqual(state.loadingIds, []);
    assert.equal(state.queue[0].prompt, 'Queued while creating');
    assert.equal(askCalls[0].prompt, 'First prompt');

    askCalls[0].resolve('First answer');
    await new Promise(setImmediate);
    assert.equal(askCalls[1].prompt, 'Queued while creating');
    assert.deepEqual(
      state.messages.map((message) => message.role),
      ['user', 'agent', 'user'],
    );

    askCalls[1].resolve('Second answer');
    await new Promise(setImmediate);
    assert.deepEqual(state.pendingIds, []);
    assert.deepEqual(
      state.messages.map((message) => message.role),
      ['user', 'agent', 'user', 'agent'],
    );
  });

  it('ignores a stale load after reconnect and allows the session to be loaded again', async () => {
    const key = agentSessionKey('codex', 'acp-1');
    const state = createPanelState({
      sessions: [{ key, agent: 'codex', sessionId: 'acp-1', cwd: '/repo' }],
    });
    const runtime = createSessionRuntime(state);
    let resolveFirstLoad;
    let loadCount = 0;
    let onFirstLoadStarted;
    const firstLoadStarted = new Promise((resolve) => {
      onFirstLoadStarted = resolve;
    });
    const controller = createSessionController({
      state,
      runtime,
      turns: noopTurns,
      api: {
        closeSession: async () => true,
        loadSession: () => {
          loadCount += 1;
          if (loadCount === 1) {
            onFirstLoadStarted();
            return new Promise((resolve) => (resolveFirstLoad = resolve));
          }
          return Promise.resolve({ configOptions: [{ id: 'model' }] });
        },
      },
    });

    const staleLoad = controller.openSession(key);
    await firstLoadStarted;
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

  it('stays on the selected session and records the error when loadSession fails', async () => {
    const previousKey = agentSessionKey('codex', 'prev');
    const targetKey = agentSessionKey('codex', 'target');
    const sessions = [
      { key: previousKey, agent: 'codex', sessionId: 'prev' },
      { key: targetKey, agent: 'codex', sessionId: 'target' },
    ];
    const state = createPanelState({ sessions, sessionKey: previousKey });
    const runtime = createSessionRuntime(state);
    runtime.setCachedPane(previousKey, {
      messages: [{ role: 'agent', text: 'Previous' }],
      configOptions: [],
      cwd: '/prev',
      queue: [],
    });
    let loadShouldFail = true;
    let loadAttempts = 0;
    const controller = createSessionController({
      state,
      runtime,
      turns: noopTurns,
      api: {
        closeSession: async () => true,
        loadSession: () => {
          loadAttempts += 1;
          if (loadShouldFail) return Promise.reject(new Error('Session not found'));
          return Promise.resolve({ configOptions: [{ id: 'model' }] });
        },
      },
    });

    await controller.openSession(targetKey);

    assert.equal(state.sessionKey, targetKey);
    assert.equal(state.sessionErrors[targetKey], 'Session not found');
    assert.equal(state.loadingIds.includes(targetKey), false);
    assert.equal(runtime.hasCachedPane(targetKey), false);

    // Clicking target session again retries loading
    loadShouldFail = false;
    await controller.openSession(targetKey);

    assert.equal(loadAttempts, 2);
    assert.equal(state.sessionKey, targetKey);
    assert.equal(state.sessionErrors[targetKey], undefined);
    assert.equal(runtime.hasCachedPane(targetKey), true);
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

  it('removes the session locally and activates fallback even if agent deleteSession fails', async () => {
    const previousKey = agentSessionKey('codex', 'previous');
    const currentKey = agentSessionKey('codex', 'current');
    const sessions = [
      { key: previousKey, agent: 'codex', sessionId: 'previous' },
      { key: currentKey, agent: 'codex', sessionId: 'current' },
    ];
    storage[localStorageKeys.agentPanelState] = {
      sessions,
      defaults: { agent: 'codex', configOptionsByAgent: {} },
    };
    const state = createPanelState({
      sessions,
      sessionKey: currentKey,
      sessionErrors: { [currentKey]: 'session is archived' },
    });
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
        deleteSession: () => Promise.reject(new Error('session is archived')),
      },
    });

    await controller.deleteSession(currentKey);

    assert.equal(state.sessionKey, previousKey);
    assert.equal(state.error, '');
    assert.equal(state.sessionErrors[currentKey], undefined);
    assert.equal(state.sessionErrors[previousKey], undefined);
    assert.deepEqual(
      state.sessions.map((session) => session.key),
      [previousKey],
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
