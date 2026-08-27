import { agentSessionKey, sessionTitleFromPrompt } from '../../shared/agent-session-store.js';

export function createTurnController({ state, runtime, api, scrollToLatest, startDraftTurn }) {
  const permissionResolves = new Map();
  const runningTurns = new Map();
  const canceledSessions = new Set();

  /** Await the user's pick for one permission request; keyed by session so
   * requests survive switching and are answered when their session shows. */
  const requestPermission = (request) => {
    const { agent, sessionId } = request || {};
    if (typeof agent !== 'string' || !agent || typeof sessionId !== 'string' || !sessionId) {
      return Promise.reject(new Error('Permission request without agent session'));
    }
    const sessionKey = agentSessionKey(agent, sessionId);
    // At most one outstanding request per session: decline a stray old one.
    decidePermission(sessionKey, null);
    return new Promise((resolve) => {
      permissionResolves.set(sessionKey, resolve);
      state({ permissions: { ...state.permissions, [sessionKey]: request } });
    });
  };

  /** Resolve the awaited permission of one session; `null` declines it. */
  const decidePermission = (sessionKey, optionId) => {
    if (!sessionKey) return;
    const resolve = permissionResolves.get(sessionKey);
    if (!resolve && !state.permissions[sessionKey]) return;
    permissionResolves.delete(sessionKey);
    const permissions = { ...state.permissions };
    delete permissions[sessionKey];
    state({ permissions });
    resolve?.(optionId);
  };

  const declineAllPermissions = () => {
    for (const sessionKey of [...permissionResolves.keys()]) decidePermission(sessionKey, null);
  };

  /** Run one turn against the host; events keep following their session when
   * the user switches away. */
  const performTurn = async (sessionKey, { prompt, attachments }) => {
    if (sessionKey === state.sessionKey) scrollToLatest?.();
    const target = runtime.target(sessionKey);
    if (!target) return;
    const turnStart = (runtime.getPane(sessionKey)?.messages ?? []).length;
    const wireAttachments = attachments.map((item) =>
      item.kind === 'image'
        ? { type: 'image', data: item.data, mimeType: item.mimeType }
        : { type: 'text', text: `<attachment name="${item.name}">\n${item.text}\n</attachment>` },
    );
    runtime.clearError(sessionKey);
    runtime.setPending(sessionKey, true);
    runtime.setPane(sessionKey, {
      messages: [...(runtime.getPane(sessionKey)?.messages ?? []), { role: 'user', text: prompt, attachments }],
    });
    const current = runtime.record(sessionKey);
    const title = current?.title ? '' : sessionTitleFromPrompt(prompt);
    runtime.patchRecord(sessionKey, {
      ...(title && { title }),
      updatedAt: new Date().toISOString(),
    });
    try {
      const answer = await api.ask(prompt, {
        ...target,
        onEvent: (event) => runtime.applyEvent(sessionKey, event),
        attachments: wireAttachments,
      });
      runtime.finishThought(sessionKey);
      const messages = runtime.getPane(sessionKey)?.messages ?? [];
      const receivedAgentText = messages.slice(turnStart).some((message) => message.role === 'agent' && message.text);
      if (answer && !receivedAgentText) {
        runtime.setPane(sessionKey, { messages: [...messages, { role: 'agent', text: answer }] });
      }
    } catch (e) {
      // Failed and canceled turns leave queued prompts for explicit retry.
      canceledSessions.delete(sessionKey);
      runtime.finishThought(sessionKey);
      runtime.setError(sessionKey, e.message);
      return;
    } finally {
      runtime.setPending(sessionKey, false);
    }
    if (!canceledSessions.delete(sessionKey)) drainQueue(sessionKey);
  };

  /** Track the settling promise so cancel-and-replace can await it. */
  const run = (sessionKey, payload) => {
    const turn = performTurn(sessionKey, payload)
      .catch(() => {})
      .finally(() => {
        if (runningTurns.get(sessionKey) === turn) runningTurns.delete(sessionKey);
      });
    runningTurns.set(sessionKey, turn);
  };

  /** After a successful turn, auto-send the next queued prompt in order. */
  const drainQueue = (sessionKey) => {
    if (state.pendingIds.includes(sessionKey)) return;
    const [next, ...rest] = runtime.getPane(sessionKey)?.queue ?? [];
    if (!next) return;
    runtime.setPane(sessionKey, { queue: rest });
    run(sessionKey, next);
  };

  /** Abort one in-flight turn and decline any permission it is awaiting. */
  const abort = async (sessionKey) => {
    decidePermission(sessionKey, null);
    const turn = runningTurns.get(sessionKey);
    if (!turn) return;
    const target = runtime.target(sessionKey);
    if (!target) return;
    canceledSessions.add(sessionKey);
    try {
      await api.cancelPrompt(target.sessionId, { agent: target.agent });
    } catch (e) {
      runtime.setError(sessionKey, e.message);
    }
    await turn;
  };

  /** Accept a composer send: deliver it when idle, queue it during a turn. */
  const send = ({ prompt, attachments }) => {
    const sessionKey = state.sessionKey;
    if ((!prompt && !attachments.length) || !sessionKey) return;
    if (state.loadingIds.includes(sessionKey)) return;
    if (state.pendingIds.includes(sessionKey)) {
      runtime.setPane(sessionKey, {
        queue: [...(runtime.getPane(sessionKey)?.queue ?? []), { id: crypto.randomUUID(), prompt, attachments }],
      });
      return;
    }
    if (runtime.record(sessionKey)?.draft) {
      startDraftTurn(sessionKey, { prompt, attachments });
      return;
    }
    run(sessionKey, { prompt, attachments });
  };

  /** Send one queued prompt now, canceling the current turn first if needed. */
  const flushQueued = async (sessionKey, itemId) => {
    const item = (runtime.getPane(sessionKey)?.queue ?? []).find((entry) => entry.id === itemId);
    if (!item) return;
    if (!state.pendingIds.includes(sessionKey)) {
      runtime.setPane(sessionKey, {
        queue: (runtime.getPane(sessionKey)?.queue ?? []).filter((entry) => entry.id !== itemId),
      });
      run(sessionKey, item);
      return;
    }
    await abort(sessionKey);
    if (state.pendingIds.includes(sessionKey)) return;
    const queue = runtime.getPane(sessionKey)?.queue ?? [];
    if (!queue.some((entry) => entry.id === itemId)) return;
    runtime.setPane(sessionKey, { queue: queue.filter((entry) => entry.id !== itemId) });
    run(sessionKey, item);
  };

  const removeQueued = (sessionKey, itemId) => {
    runtime.setPane(sessionKey, {
      queue: (runtime.getPane(sessionKey)?.queue ?? []).filter((entry) => entry.id !== itemId),
    });
  };

  const updateQueued = (sessionKey, { id, prompt, attachments }) => {
    const queue = runtime.getPane(sessionKey)?.queue ?? [];
    const next = queue.some((entry) => entry.id === id)
      ? queue.map((entry) => (entry.id === id ? { id, prompt, attachments } : entry))
      : [...queue, { id, prompt, attachments }];
    runtime.setPane(sessionKey, { queue: next });
  };

  return {
    requestPermission,
    decidePermission,
    declineAllPermissions,
    clearCanceledSessions: () => canceledSessions.clear(),
    send,
    cancel: () => state.sessionKey && abort(state.sessionKey),
    run,
    abort,
    flushQueued,
    removeQueued,
    updateQueued,
  };
}
