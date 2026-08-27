import { addListener } from '@mantou/gem/lib/utils';
import { createAgentApi } from '../shared/agent-api.js';
import {
  agentSessionKey,
  observeAgentPanelState,
  readAgentPanelState,
  removeStoredSession,
  sessionTitleFromPrompt,
  updateAgentPanelState,
  upsertStoredSession,
} from '../shared/agent-session-store.js';
import { setPageI18n, t } from '../shared/i18n.js';
import { displayHomePath } from '../shared/path.js';

setPageI18n();

const agentApi = createAgentApi();
const DRAFT_SESSION_KEY = 'draft';

function getPanelContext() {
  const tabId = globalThis.chrome?.devtools?.inspectedWindow?.tabId;
  return Number.isInteger(tabId) ? { surface: 'devtools', tabId } : { surface: 'side_panel' };
}

/** Keep the `mode` config option in sync with a `current_mode_update`. */
function withCurrentMode(configOptions, currentModeId) {
  return configOptions.map((option) => (option.id === 'mode' ? { ...option, currentValue: currentModeId } : option));
}

/** Keep one config option in sync with a locally staged change. */
function withConfigValue(configOptions, configId, value) {
  return configOptions.map((option) => (option.id === configId ? { ...option, currentValue: value } : option));
}

function withAgentConfigOptions(state, agent, configOptions) {
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

const style = css`
  :scope {
    display: block;
    height: 100vh;
    font-size: 14px;
  }
`;

@customElement('agent-panel-page')
@adoptedStyle(style)
class AgentPanelPageElement extends GemElement {
  @boolattribute showEvents;

  #s = createState({
    compact: false,
    sessions: [], // persisted local records: { key, agent, sessionId, title?, cwd?, updatedAt? }
    draftSession: null, // at most one local session without an ACP session id; never persisted
    defaults: { agent: '', configOptionsByAgent: {} },
    agents: [], // locally available ACP agents
    sessionKey: null, // unique local key of the displayed session
    messages: [], // text messages, thought blocks, tool calls, or raw events
    configOptions: [], // draft composer settings, or a live session's applied ACP options
    queue: [], // prompts staged while the displayed session has one in flight
    pendingIds: [], // local session keys with a prompt in flight
    booting: true, // initial local state loading (whole page loader)
    loadingIds: [], // local session keys being created or loaded
    deleting: null, // local session key being deleted
    error: '', // global errors (storage/delete/create), transient
    sessionErrors: {}, // per-session last error, shown when that session displays
    cwd: '',
    home: '',
    newSessionOpen: false,
    permissions: {}, // per-session outstanding permission request: local key -> request
  });

  #permissionResolves = new Map(); // local session key -> resolve of the awaited ask
  #chatPaneRef = createRef();
  // Pane state by local session key: { messages, configOptions, cwd, queue }.
  // Switching keeps live ACP sessions running and restores their UI instantly.
  #sessionCache = new Map();
  // Loads still running: local session key -> { alive }; `alive` is cleared when the
  // session dies so a settling load no longer touches the panel state.
  #pendingLoads = new Map();
  // Turns still running: local session key -> settle promise of #performTurn.
  #runningTurns = new Map();
  // Sessions whose settling turn was canceled: a canceled turn resolves like
  // a normal one (ACP reports a stop), so the cancel site marks the session
  // here to keep the queue from auto-draining over the user's stop.
  #canceledSessions = new Set();
  @mounted()
  #boot = async () => {
    try {
      try {
        const stored = await readAgentPanelState();
        this.#s({ sessions: stored.sessions, defaults: stored.defaults });
      } catch (e) {
        this.#s({ error: e.message });
      }
      await Promise.all([this.#loadHome(), this.#loadAgents()]);
    } finally {
      this.#s({ booting: false });
    }
  };

  @mounted()
  #setup = () => {
    const compactMediaQuery = matchMedia('(width <= 1280px)');
    this.#s({ compact: compactMediaQuery.matches });
    agentApi.setPermissionHandler(this.#requestPermission);
    agentApi.setSessionEndedHandler(({ agent, sessionId }) => {
      const sessionKey = agentSessionKey(agent, sessionId);
      const record = this.#pendingLoads.get(sessionKey);
      if (record) {
        record.alive = false;
        this.#pendingLoads.delete(sessionKey);
        this.#setSessionLoading(sessionKey, false);
      }
      this.#sessionCache.delete(sessionKey);
      this.#decidePermission(sessionKey, null);
      if (sessionKey === this.#s.sessionKey) {
        this.#s({
          sessionKey: null,
          messages: [],
          configOptions: [],
          queue: [],
          cwd: '',
        });
      }
    });
    agentApi.setHostReconnectedHandler(() => {
      // A fresh host process keeps no live ACP sessions. Preserve the purely
      // local draft; every live-session cache entry and in-flight load is stale.
      for (const sessionKey of [...this.#permissionResolves.keys()]) {
        this.#decidePermission(sessionKey, null);
      }
      for (const record of this.#pendingLoads.values()) record.alive = false;
      this.#pendingLoads.clear();
      const draftCache = this.#s.draftSession && this.#sessionCache.get(this.#s.draftSession.key);
      const draftLoading = Boolean(draftCache && this.#s.loadingIds.includes(DRAFT_SESSION_KEY));
      this.#sessionCache.clear();
      if (draftCache) this.#sessionCache.set(DRAFT_SESSION_KEY, draftCache);
      const currentSessionKey = this.#s.sessionKey;
      const currentIsDraft = this.#s.draftSession?.key === currentSessionKey;
      this.#canceledSessions.clear();
      this.#s({
        loadingIds: draftLoading ? [DRAFT_SESSION_KEY] : [],
        pendingIds: [],
        permissions: {},
        sessionErrors: {},
        ...(!currentIsDraft &&
          currentSessionKey && {
            sessionKey: null,
            messages: [],
            configOptions: [],
            queue: [],
            cwd: '',
            error: t('devtoolsPanelHostReconnected'),
          }),
      });
    });
    const removeMediaQueryListener = addListener(compactMediaQuery, 'change', this.#updateCompactMode);
    const stopObservingStorage = observeAgentPanelState(({ sessions, defaults }) => {
      this.#s({ sessions, defaults });
    });
    return () => {
      removeMediaQueryListener();
      stopObservingStorage();
      // Decline every awaited permission: the panel cannot answer anymore.
      for (const sessionKey of [...this.#permissionResolves.keys()]) {
        this.#decidePermission(sessionKey, null);
      }
      agentApi.setPermissionHandler(null);
      agentApi.setSessionEndedHandler(null);
      agentApi.setHostReconnectedHandler(null);
    };
  };

  #updateCompactMode = ({ matches }) => {
    this.#s({ compact: matches });
  };

  /** Await the user's pick for one permission request; keyed by session so
   * requests survive switching and are answered when their session shows. */
  #requestPermission = (request) => {
    const { agent, sessionId } = request || {};
    if (typeof agent !== 'string' || !agent || typeof sessionId !== 'string' || !sessionId) {
      return Promise.reject(new Error('Permission request without agent session'));
    }
    const sessionKey = agentSessionKey(agent, sessionId);
    // At most one outstanding request per session: decline a stray old one.
    this.#decidePermission(sessionKey, null);
    return new Promise((resolve) => {
      this.#permissionResolves.set(sessionKey, resolve);
      this.#s({ permissions: { ...this.#s.permissions, [sessionKey]: request } });
    });
  };

  /** Resolve the awaited permission of one session; `null` declines it. */
  #decidePermission = (sessionKey, optionId) => {
    if (!sessionKey) return;
    const resolve = this.#permissionResolves.get(sessionKey);
    if (!resolve && !this.#s.permissions[sessionKey]) return;
    this.#permissionResolves.delete(sessionKey);
    const permissions = { ...this.#s.permissions };
    delete permissions[sessionKey];
    this.#s({ permissions });
    resolve?.(optionId);
  };

  #loadAgents = async () => {
    try {
      const { agents } = await agentApi.listAgents();
      this.#s({ agents: agents || [] });
    } catch (e) {
      this.#s({ error: e.message });
    }
  };

  #loadHome = async () => {
    try {
      const { value } = await agentApi.completeCwd('');
      this.#s({ home: value || '' });
    } catch {
      // Home shortening is optional; absolute paths remain usable.
    }
  };

  #sessionRecord = (sessionKey) =>
    this.#s.draftSession?.key === sessionKey
      ? this.#s.draftSession
      : this.#s.sessions.find((session) => session.key === sessionKey);

  get #sessionList() {
    const { draftSession, sessions } = this.#s;
    return draftSession ? [draftSession, ...sessions] : sessions;
  }

  #sessionTarget = (sessionKey) => {
    const session = this.#sessionRecord(sessionKey);
    return session?.sessionId ? { agent: session.agent, sessionId: session.sessionId } : null;
  };

  #mutateStoredState = async (update) => {
    const local = update({ sessions: this.#s.sessions, defaults: this.#s.defaults });
    this.#s({ sessions: local.sessions, defaults: local.defaults });
    try {
      const stored = await updateAgentPanelState(update);
      this.#s({ sessions: stored.sessions, defaults: stored.defaults });
    } catch (e) {
      this.#s({ error: e.message });
    }
  };

  #patchSession = (sessionKey, patch) => {
    const current = this.#s.sessions.find((session) => session.key === sessionKey);
    if (!current) return Promise.resolve();
    return this.#mutateStoredState((state) => {
      const stored = state.sessions.find((session) => session.key === sessionKey);
      return stored ? upsertStoredSession(state, { ...stored, ...patch }) : state;
    });
  };

  #removeSessionRecord = (sessionKey) => this.#mutateStoredState((state) => removeStoredSession(state, sessionKey));

  #completeThought = (messages) => {
    const last = messages.at(-1);
    if (last?.type !== 'thought' || !last.pending) return messages;
    const next = messages.slice();
    next[next.length - 1] = { ...last, pending: false };
    return next;
  };

  /** Read/write access to one session's chat state: the live pane when it is
   * the displayed session, otherwise its kept-alive cache entry. */
  #sessionStore = (sessionKey) => ({
    get: () => (sessionKey === this.#s.sessionKey ? this.#s : this.#sessionCache.get(sessionKey)),
    set: (patch) => {
      if (sessionKey === this.#s.sessionKey) {
        this.#s(patch);
      } else if (this.#sessionCache.has(sessionKey)) {
        this.#sessionCache.set(sessionKey, { ...this.#sessionCache.get(sessionKey), ...patch });
      }
    },
  });

  #finishThought = (sessionKey) => {
    const store = this.#sessionStore(sessionKey);
    const messages = this.#completeThought(store.get()?.messages ?? []);
    if (messages !== store.get()?.messages) store.set({ messages });
  };

  /** Apply one ACP event to the session it belongs to. */
  #applyEvent = (sessionKey, event) => {
    if (event.event !== 'session_update') {
      if (event.event === 'stop') this.#finishThought(sessionKey);
      return;
    }
    const store = this.#sessionStore(sessionKey);
    const state = store.get();
    const { update } = event;
    const thoughtChunk = update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text';
    const currentMessages = thoughtChunk ? (state?.messages ?? []) : this.#completeThought(state?.messages ?? []);
    // Text chunks: live turns stream agent chunks; load replays both roles
    const role =
      update.sessionUpdate === 'agent_message_chunk'
        ? 'agent'
        : update.sessionUpdate === 'user_message_chunk'
          ? 'user'
          : null;
    if (role && update.content?.type === 'text') {
      store.set({
        messages: appendChunk(
          currentMessages,
          (last) => last?.role === role,
          (last) => (last ? { ...last, text: last.text + update.content.text } : { role, text: update.content.text }),
        ),
      });
    } else if (role && update.content?.type === 'image' && update.content.data) {
      const { mimeType = 'image/png', data } = update.content;
      const attachment = {
        id: crypto.randomUUID(),
        kind: 'image',
        name: t('devtoolsPanelImageAttachment'),
        mimeType,
        previewUrl: `data:${mimeType};base64,${data}`,
      };
      store.set({
        messages: appendChunk(
          currentMessages,
          (last) => last?.role === role,
          (last) =>
            last
              ? { ...last, attachments: [...(last.attachments || []), attachment] }
              : { role, text: '', attachments: [attachment] },
        ),
      });
    } else if (thoughtChunk) {
      store.set({
        messages: appendChunk(
          currentMessages,
          (last) => last?.type === 'thought',
          (last) =>
            last
              ? { ...last, text: last.text + update.content.text, pending: true }
              : { type: 'thought', text: update.content.text, pending: true },
        ),
      });
    } else if (update.sessionUpdate === 'tool_call') {
      store.set({ messages: [...currentMessages, { type: 'tool', data: update }] });
    } else if (update.sessionUpdate === 'tool_call_update') {
      const messages = currentMessages.slice();
      const index = messages.findLastIndex(
        (message) => message.type === 'tool' && message.data.toolCallId === update.toolCallId,
      );
      if (index === -1) {
        messages.push({ type: 'tool', data: update });
      } else {
        messages[index] = {
          ...messages[index],
          data: { ...messages[index].data, ...update, sessionUpdate: 'tool_call' },
        };
      }
      messages.push({ type: 'event', data: update });
      store.set({ messages });
    } else if (update.sessionUpdate === 'current_mode_update') {
      // Selector state, not chat content: keep the mode entry current.
      store.set({ configOptions: withCurrentMode(state?.configOptions ?? [], update.currentModeId) });
    } else if (update.sessionUpdate === 'config_option_update') {
      store.set({ configOptions: Array.isArray(update.configOptions) ? update.configOptions : [] });
    } else if (update.sessionUpdate === 'session_info_update') {
      const patch = {};
      if (typeof update.title === 'string' && update.title) patch.title = update.title;
      if (typeof update.updatedAt === 'string' && update.updatedAt) patch.updatedAt = update.updatedAt;
      if (Object.keys(patch).length) this.#patchSession(sessionKey, patch);
    } else {
      // Surface other ACP session updates (tool calls, plans, …) for inspection
      store.set({ messages: [...currentMessages, { type: 'event', data: update }] });
    }
  };

  /** Accept a composer send: deliver it when idle, stage it otherwise.
   * The composer clears its text input before this. */
  #send = ({ prompt, attachments }) => {
    const sessionKey = this.#s.sessionKey;
    if ((!prompt && !attachments.length) || !sessionKey) return;
    if (this.#s.loadingIds.includes(sessionKey)) return;
    if (this.#s.pendingIds.includes(sessionKey)) {
      const store = this.#sessionStore(sessionKey);
      store.set({
        queue: [...(store.get()?.queue ?? []), { id: crypto.randomUUID(), prompt, attachments }],
      });
      return;
    }
    if (this.#sessionRecord(sessionKey)?.draft) {
      this.#startDraftTurn(sessionKey, { prompt, attachments });
      return;
    }
    this.#runTurn(sessionKey, { prompt, attachments });
  };

  /** After a successful turn, auto-send the next staged prompt in order. */
  #drainQueue = (sessionKey) => {
    if (this.#s.pendingIds.includes(sessionKey)) return;
    const store = this.#sessionStore(sessionKey);
    const [next, ...rest] = store.get()?.queue ?? [];
    if (!next) return;
    store.set({ queue: rest });
    this.#runTurn(sessionKey, next);
  };

  /** Send a staged prompt now: idle sends right away; a running turn is
   * canceled first so this prompt goes out immediately. */
  #flushQueued = async (sessionKey, itemId) => {
    const store = this.#sessionStore(sessionKey);
    const item = (store.get()?.queue ?? []).find((entry) => entry.id === itemId);
    if (!item) return;
    if (!this.#s.pendingIds.includes(sessionKey)) {
      store.set({ queue: (store.get()?.queue ?? []).filter((entry) => entry.id !== itemId) });
      this.#runTurn(sessionKey, item);
      return;
    }
    await this.#abortTurn(sessionKey);
    // The turn refused to stop, or the item was deleted while canceling.
    if (this.#s.pendingIds.includes(sessionKey)) return;
    const queue = store.get()?.queue ?? [];
    if (!queue.some((entry) => entry.id === itemId)) return;
    store.set({ queue: queue.filter((entry) => entry.id !== itemId) });
    this.#runTurn(sessionKey, item);
  };

  /** Drop one staged prompt. */
  #removeQueued = (sessionKey, itemId) => {
    const store = this.#sessionStore(sessionKey);
    store.set({ queue: (store.get()?.queue ?? []).filter((entry) => entry.id !== itemId) });
  };

  /** Patch one staged prompt in place (the composer's edit flow). A stale
   * id falls back to appending, so the edit is never silently lost. */
  #updateQueued = (sessionKey, { id, prompt, attachments }) => {
    const store = this.#sessionStore(sessionKey);
    const queue = store.get()?.queue ?? [];
    const next = queue.some((entry) => entry.id === id)
      ? queue.map((entry) => (entry.id === id ? { id, prompt, attachments } : entry))
      : [...queue, { id, prompt, attachments }];
    store.set({ queue: next });
  };

  /** Run one turn; the settle promise is tracked so a queued prompt can
   * cancel-and-replace it. */
  #runTurn = (sessionKey, payload) => {
    const turn = this.#performTurn(sessionKey, payload)
      .catch(() => {})
      .finally(() => {
        if (this.#runningTurns.get(sessionKey) === turn) this.#runningTurns.delete(sessionKey);
      });
    this.#runningTurns.set(sessionKey, turn);
  };

  /** Run one turn against the host; events stream into the session store,
   * which keeps working when the user switches away mid-turn. */
  #performTurn = async (sessionKey, { prompt, attachments }) => {
    if (sessionKey === this.#s.sessionKey) this.#chatPaneRef.value?.scrollToLatest(true);
    const target = this.#sessionTarget(sessionKey);
    if (!target) return;
    const store = this.#sessionStore(sessionKey);
    const turnStart = (store.get()?.messages ?? []).length;
    // Wire format: images as base64 blocks; text files wrapped so the agent
    // can tell them apart from the user's own words.
    const wireAttachments = attachments.map((item) =>
      item.kind === 'image'
        ? { type: 'image', data: item.data, mimeType: item.mimeType }
        : { type: 'text', text: `<attachment name="${item.name}">\n${item.text}\n</attachment>` },
    );
    this.#clearSessionError(sessionKey);
    this.#setSessionPending(sessionKey, true);
    store.set({
      messages: [...(store.get()?.messages ?? []), { role: 'user', text: prompt, attachments }],
    });
    const current = this.#sessionRecord(sessionKey);
    const title = current?.title ? '' : sessionTitleFromPrompt(prompt);
    this.#patchSession(sessionKey, {
      ...(title && { title }),
      updatedAt: new Date().toISOString(),
    });
    try {
      // The turn keeps running when the user switches away; its events and
      // the final answer follow the session via the store.
      const answer = await agentApi.ask(prompt, {
        ...target,
        onEvent: (event) => this.#applyEvent(sessionKey, event),
        attachments: wireAttachments,
      });
      this.#finishThought(sessionKey);
      const messages = store.get()?.messages ?? [];
      const receivedAgentText = messages.slice(turnStart).some((message) => message.role === 'agent' && message.text);
      if (answer && !receivedAgentText) {
        store.set({ messages: [...messages, { role: 'agent', text: answer }] });
      }
    } catch (e) {
      // A failed or canceled turn stops the auto-drain; staged prompts stay
      // editable in the queue instead of firing into a broken session.
      this.#canceledSessions.delete(sessionKey);
      this.#finishThought(sessionKey);
      this.#setSessionError(sessionKey, e.message);
      return;
    } finally {
      this.#setSessionPending(sessionKey, false);
    }
    // A canceled turn resolves like a successful one, so the explicit mark
    // from #abortTurn is what stops the auto-drain.
    if (!this.#canceledSessions.delete(sessionKey)) this.#drainQueue(sessionKey);
  };

  #cancel = () => {
    const sessionKey = this.#s.sessionKey;
    if (sessionKey) this.#abortTurn(sessionKey);
  };

  /** Abort the session's in-flight turn; also declines its awaited
   * permission. Resolves once the aborted turn has fully settled. */
  #abortTurn = async (sessionKey) => {
    this.#decidePermission(sessionKey, null);
    const turn = this.#runningTurns.get(sessionKey);
    if (!turn) return;
    const target = this.#sessionTarget(sessionKey);
    if (!target) return;
    this.#canceledSessions.add(sessionKey);
    try {
      await agentApi.cancelPrompt(target.sessionId, { agent: target.agent });
    } catch (e) {
      this.#setSessionError(sessionKey, e.message);
    }
    await turn;
  };

  #newSession = () => {
    if (this.#s.loadingIds.includes(DRAFT_SESSION_KEY)) return;
    this.#s({ newSessionOpen: true, error: '' });
  };

  /** Stash the right-pane state of the current session for later reuse. */
  #snapshotSession = () => {
    const sessionKey = this.#s.sessionKey;
    if (!sessionKey) return;
    this.#sessionCache.set(sessionKey, {
      messages: this.#completeThought(this.#s.messages),
      configOptions: this.#s.configOptions,
      cwd: this.#s.cwd,
      queue: this.#s.queue,
    });
  };

  #setSessionLoading = (sessionKey, loading) => {
    const loadingIds = this.#s.loadingIds.filter((key) => key !== sessionKey);
    if (loading) loadingIds.push(sessionKey);
    this.#s({ loadingIds });
  };

  #setSessionPending = (sessionKey, pending) => {
    const pendingIds = this.#s.pendingIds.filter((key) => key !== sessionKey);
    if (pending) pendingIds.push(sessionKey);
    this.#s({ pendingIds });
  };

  /** Record an error against its session; without one, fall back to global. */
  #setSessionError = (sessionKey, message) => {
    if (!sessionKey) {
      this.#s({ error: message });
      return;
    }
    this.#s({ sessionErrors: { ...this.#s.sessionErrors, [sessionKey]: message } });
  };

  #clearSessionError = (sessionKey) => {
    if (!sessionKey || !this.#s.sessionErrors[sessionKey]) return;
    const sessionErrors = { ...this.#s.sessionErrors };
    delete sessionErrors[sessionKey];
    this.#s({ sessionErrors });
  };

  #persistAgentDefault = (agent) =>
    this.#mutateStoredState((state) => ({
      ...state,
      defaults: { ...state.defaults, agent },
    }));

  #persistConfigOptions = (agent, configOptions) =>
    this.#mutateStoredState((state) => withAgentConfigOptions(state, agent, configOptions));

  #applyComposerConfig = async (target, configOptions, composerConfigOptions) => {
    let current = configOptions;
    for (const selected of composerConfigOptions) {
      const option = current.find((item) => item.id === selected.id);
      const value = selected.currentValue;
      const supported = option?.options?.some((item) => item.value === value);
      if (!value || !supported || option.currentValue === value) continue;
      const result = await agentApi.setSessionConfigOption(target.sessionId, option.id, value, {
        agent: target.agent,
      });
      current = Array.isArray(result.configOptions) ? result.configOptions : withConfigValue(current, option.id, value);
    }
    return current;
  };

  #startDraftTurn = async (sessionKey, payload) => {
    const draft = this.#sessionRecord(sessionKey);
    const draftState = this.#sessionStore(sessionKey).get();
    if (!draft?.draft || !draftState) return;
    const { configOptions: composerConfigOptions, messages: draftMessages } = draftState;
    let createdTarget;
    this.#clearSessionError(sessionKey);
    this.#setSessionLoading(sessionKey, true);
    try {
      const created = await agentApi.createSession({
        agent: draft.agent,
        cwd: draft.cwd,
        panelContext: getPanelContext(),
      });
      createdTarget = { agent: draft.agent, sessionId: created.sessionId };
      const configOptions = await this.#applyComposerConfig(
        createdTarget,
        created.configOptions || [],
        composerConfigOptions,
      );
      const liveSessionKey = agentSessionKey(draft.agent, created.sessionId);
      const now = new Date().toISOString();
      const session = {
        key: liveSessionKey,
        agent: draft.agent,
        sessionId: created.sessionId,
        title: created.title || sessionTitleFromPrompt(payload.prompt),
        cwd: draft.cwd,
        createdAt: now,
        updatedAt: created.updatedAt || now,
      };
      const cache = {
        messages: draftMessages,
        configOptions,
        cwd: draft.cwd,
        queue: [],
      };
      const isCurrent = this.#s.sessionKey === sessionKey;
      this.#sessionCache.delete(sessionKey);
      this.#sessionCache.set(liveSessionKey, cache);
      this.#s({ draftSession: null });
      if (isCurrent) {
        this.#s({
          sessionKey: liveSessionKey,
          messages: cache.messages,
          configOptions,
          queue: cache.queue,
          cwd: cache.cwd,
          error: '',
        });
      }
      this.#setSessionLoading(sessionKey, false);
      const persistence = this.#mutateStoredState((state) =>
        upsertStoredSession(withAgentConfigOptions(state, draft.agent, configOptions), session),
      );
      createdTarget = null;
      this.#runTurn(liveSessionKey, payload);
      await persistence;
    } catch (e) {
      if (createdTarget) agentApi.closeSession(createdTarget.sessionId, { agent: createdTarget.agent }).catch(() => {});
      this.#setSessionError(sessionKey, e.message);
      this.#setSessionLoading(sessionKey, false);
    }
  };

  #confirmNewSession = ({ agent, cwd }) => {
    this.#snapshotSession();
    const now = new Date().toISOString();
    const draftSession = {
      key: DRAFT_SESSION_KEY,
      agent,
      title: '',
      cwd,
      createdAt: now,
      updatedAt: now,
      draft: true,
    };
    const configOptions = this.#s.defaults.configOptionsByAgent[agent] || [];
    this.#sessionCache.set(DRAFT_SESSION_KEY, { messages: [], configOptions, cwd, queue: [] });
    this.#s({
      draftSession,
      sessionKey: DRAFT_SESSION_KEY,
      messages: [],
      configOptions,
      queue: [],
      cwd,
      newSessionOpen: false,
      error: '',
    });
    this.#persistAgentDefault(agent);
  };

  #openSession = async (sessionKey) => {
    const isCurrent = sessionKey === this.#s.sessionKey;
    if (isCurrent && (this.#sessionCache.has(sessionKey) || this.#pendingLoads.has(sessionKey))) return;
    const previous = isCurrent ? null : this.#s.sessionKey;
    if (!isCurrent) this.#snapshotSession();
    const selected = this.#sessionRecord(sessionKey);
    if (!selected) return;
    this.#s({ error: '' });
    // Still live in this panel: swap in the cached state without a host call.
    // A load still running for it keeps streaming into the pane.
    const cached = this.#sessionCache.get(sessionKey);
    if (cached) {
      this.#s({
        sessionKey,
        messages: cached.messages,
        configOptions: cached.configOptions,
        queue: cached.queue,
        cwd: cached.cwd,
      });
      return;
    }
    this.#clearSessionError(sessionKey);
    // Clear before load: the replayed history rebuilds via #applyEvent. The
    // load keeps running when the user switches away midway — its events
    // follow the session into the cache.
    this.#s({
      sessionKey,
      cwd: selected.cwd || '',
      messages: [],
      configOptions: [],
      queue: [],
    });
    this.#setSessionLoading(sessionKey, true);
    const record = { alive: true };
    this.#pendingLoads.set(sessionKey, record);
    try {
      const { configOptions, title, updatedAt } = await agentApi.loadSession(selected.sessionId, {
        agent: selected.agent,
        cwd: selected.cwd,
        onEvent: (event) => this.#applyEvent(sessionKey, event),
        panelContext: getPanelContext(),
      });
      if (!record.alive) return;
      this.#finishThought(sessionKey);
      if (title || updatedAt) {
        this.#patchSession(sessionKey, {
          ...(title && { title }),
          ...(updatedAt && { updatedAt }),
        });
      }
      if (this.#s.sessionKey === sessionKey) {
        this.#sessionCache.set(sessionKey, {
          messages: this.#s.messages,
          configOptions: configOptions || [],
          cwd: this.#s.cwd,
          queue: [],
        });
        this.#s({ configOptions: configOptions || [] });
      } else if (this.#sessionCache.has(sessionKey)) {
        // Settled in the background: fold the result into the cached entry.
        const entry = this.#sessionCache.get(sessionKey);
        this.#sessionCache.set(sessionKey, {
          ...entry,
          messages: this.#completeThought(entry.messages),
          configOptions: configOptions || [],
        });
      }
    } catch (e) {
      if (!record.alive) return;
      // The error belongs to this session; it shows when the session does.
      this.#setSessionError(sessionKey, e.message);
      if (this.#s.sessionKey !== sessionKey) return;
      // Revert to the previous session when it is still available.
      const fallback = previous ? this.#sessionCache.get(previous) : null;
      if (fallback) {
        this.#s({
          sessionKey: previous,
          messages: fallback.messages,
          configOptions: fallback.configOptions,
          queue: fallback.queue,
          cwd: fallback.cwd,
        });
      }
    } finally {
      if (this.#pendingLoads.get(sessionKey) === record) {
        this.#pendingLoads.delete(sessionKey);
        this.#setSessionLoading(sessionKey, false);
      }
    }
  };

  #deleteSession = async (sessionKey) => {
    if (this.#s.deleting) return;
    let selected = this.#sessionRecord(sessionKey);
    if (!selected) return;
    // Deletion wins over an in-flight load or turn: kill the load locally
    // (its settle path checks `alive`) and let the turn cancel first, so
    // nothing keeps streaming into a session that no longer exists.
    const loadRecord = this.#pendingLoads.get(sessionKey);
    if (loadRecord) {
      loadRecord.alive = false;
      this.#pendingLoads.delete(sessionKey);
      this.#setSessionLoading(sessionKey, false);
    }
    if (this.#s.pendingIds.includes(sessionKey)) await this.#abortTurn(sessionKey);
    selected = this.#sessionRecord(sessionKey) || selected;
    const isDraft = selected.draft === true && this.#s.draftSession?.key === sessionKey;
    const isCurrent = this.#s.sessionKey === sessionKey;
    // Optimistic removal from the list; restored if the host rejects it.
    const previousSessions = this.#s.sessions;
    const previousDraft = this.#s.draftSession;
    this.#s({
      deleting: sessionKey,
      sessions: previousSessions.filter((session) => session.key !== sessionKey),
      ...(isDraft && { draftSession: null }),
      ...(isCurrent && {
        sessionKey: null,
        messages: [],
        configOptions: [],
        queue: [],
        cwd: '',
      }),
    });
    try {
      // Live sessions (the current one, kept-alive ones, or one whose load
      // just got killed) must disconnect before removing the record.
      if (!isDraft && (isCurrent || loadRecord || this.#sessionCache.has(sessionKey)))
        await agentApi.closeSession(selected.sessionId, { agent: selected.agent }).catch(() => {});
      if (!isDraft) {
        await agentApi.deleteSession(selected.sessionId, { agent: selected.agent });
        await this.#removeSessionRecord(sessionKey);
      }
      this.#sessionCache.delete(sessionKey);
      this.#clearSessionError(sessionKey);
    } catch (err) {
      this.#s({ sessions: previousSessions, draftSession: previousDraft, error: err.message });
      return;
    } finally {
      this.#s({ deleting: null });
    }
  };

  #onSessionSelect = (e) => {
    const sessionKey = e.detail;
    if (sessionKey) this.#openSession(sessionKey);
  };

  /** Selectable session config options (mode/model/effort/…) for the composer. */
  get #configSelects() {
    const agent = this.#sessionRecord(this.#s.sessionKey)?.agent;
    return (this.#s.configOptions || []).filter(
      (option) =>
        option.type === 'select' &&
        Array.isArray(option.options) &&
        option.options.length &&
        !(agent === 'codex' && option.id === 'fast-mode'),
    );
  }

  #changeConfig = async (configId, value) => {
    const sessionKey = this.#s.sessionKey;
    if (!sessionKey) return;
    const session = this.#sessionRecord(sessionKey);
    if (!session) return;
    const store = this.#sessionStore(sessionKey);
    // Show the pick immediately instead of waiting for the host round-trip.
    const previous = store.get()?.configOptions ?? [];
    this.#clearSessionError(sessionKey);
    const staged = withConfigValue(previous, configId, value);
    store.set({ configOptions: staged });
    if (session.draft) {
      await this.#persistConfigOptions(session.agent, staged);
      return;
    }
    const target = this.#sessionTarget(sessionKey);
    if (!target) return;
    try {
      const { configOptions } = await agentApi.setSessionConfigOption(target.sessionId, configId, value, {
        agent: target.agent,
      });
      const applied = Array.isArray(configOptions) ? configOptions : staged;
      store.set({ configOptions: applied });
      await this.#persistConfigOptions(target.agent, applied);
    } catch (e) {
      this.#setSessionError(sessionKey, e.message);
      // Roll back unless a concurrent update replaced the list meanwhile.
      if (store.get()?.configOptions === staged) {
        store.set({ configOptions: previous });
      }
    }
  };

  /** Session shown in the right header: prefer its current title; a
   * just-created session has neither title nor messages yet. */
  get #currentTitle() {
    return this.#sessionRecord(this.#s.sessionKey)?.title || t('devtoolsPanelNewSession');
  }

  get #recentCwd() {
    const timestamp = (session) => Date.parse(session.updatedAt || '') || 0;
    return (
      this.#sessionList
        .filter((session) => session.cwd)
        .reduce((recent, session) => (!recent || timestamp(session) > timestamp(recent) ? session : recent), null)
        ?.cwd || this.#s.cwd
    );
  }

  @template()
  #content = () => {
    const {
      compact,
      sessionKey,
      cwd,
      agents,
      defaults,
      messages,
      booting,
      loadingIds,
      deleting,
      error,
      sessionErrors,
      pendingIds,
      permissions,
      newSessionOpen,
      home,
      queue,
    } = this.#s;

    if (booting) {
      return html`
        <div class="grid h-full place-items-center bg-bg text-describe">
          <dy-loading></dy-loading>
        </div>
      `;
    }

    const visibleMessages = this.showEvents ? messages : messages.filter((message) => message.type !== 'event');
    const sessions = this.#sessionList;
    const loadingSession = loadingIds.includes(sessionKey);
    // Session errors follow their session; a fresh global one wins the banner.
    const bannerError = error || (sessionKey ? sessionErrors[sessionKey] : '') || '';
    const initialAgent = agents.some((agent) => agent.id === defaults.agent) ? defaults.agent : agents[0]?.id;

    return html`
      <div class=${compact ? 'flex h-full flex-col' : 'flex h-full'}>
        <agent-session-list
          class="contents"
          ?compact=${compact}
          .sessions=${sessions}
          .sessionKey=${sessionKey}
          .home=${home}
          .loadingIds=${loadingIds}
          .deleting=${deleting}
          @select=${this.#onSessionSelect}
          @create=${() => this.#newSession()}
          @remove=${(e) => this.#deleteSession(e.detail)}
        ></agent-session-list>
        <agent-chat-pane
          ${this.#chatPaneRef}
          class="contents"
          ?compact=${compact}
          ?loading-session=${loadingSession}
          .sessionKey=${sessionKey}
          .title=${this.#currentTitle}
          .cwd=${displayHomePath(cwd, home)}
          .messages=${visibleMessages}
          .permissionRequest=${sessionKey ? permissions[sessionKey] : null}
          .bannerError=${bannerError}
          .configOptions=${this.#configSelects}
          .composerDisabled=${pendingIds.includes(sessionKey)}
          .queue=${queue}
          @send=${(e) => this.#send(e.detail)}
          @cancel=${this.#cancel}
          @configchange=${(e) => this.#changeConfig(e.detail.configId, e.detail.value)}
          @decision=${(e) => this.#decidePermission(sessionKey, e.detail)}
          @attacherror=${(e) => this.#setSessionError(sessionKey, e.detail)}
          @queuesend=${(e) => this.#flushQueued(sessionKey, e.detail)}
          @queueupdate=${(e) => this.#updateQueued(sessionKey, e.detail)}
          @queueremove=${(e) => this.#removeQueued(sessionKey, e.detail)}
        ></agent-chat-pane>
        <agent-new-session-modal
          v-if=${newSessionOpen}
          .open=${true}
          .customize=${true}
          .maskClosable=${true}
          @close=${() => this.#s({ newSessionOpen: false })}
        >
          <agent-new-session-picker
            class="block w-[calc(100vw-2rem)] max-w-2xl"
            .complete=${(value) => agentApi.completeCwd(value)}
            .initialValue=${displayHomePath(this.#recentCwd, home)}
            .home=${home}
            .agents=${agents}
            .initialAgent=${initialAgent}
            @confirm=${(event) => this.#confirmNewSession(event.detail)}
          ></agent-new-session-picker>
        </agent-new-session-modal>
      </div>
    `;
  };
}
