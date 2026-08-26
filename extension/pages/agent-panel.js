import { addListener } from '@mantou/gem/lib/utils';
import { polling } from 'duoyun-ui/lib/timer';
import { createAgentApi } from '../shared/agent-api.js';
import { setPageI18n, t } from '../shared/i18n.js';
import { displayHomePath } from '../shared/path.js';

setPageI18n();

const agentApi = createAgentApi();

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
    sessions: [], // persisted sessions: { sessionId, title?, cwd?, updatedAt? }
    sessionId: null, // current live session
    messages: [], // text messages, thought blocks, tool calls, or raw events
    configOptions: [], // current session's ACP config options (mode/model/effort/…)
    pendingIds: [], // session ids with a prompt in flight
    booting: true, // initial sessions fetching state (whole page loader)
    loadingSession: false, // the displayed session is being created/loaded
    loadingIds: [], // session ids with a load running in the background
    deleting: null, // session id being deleted
    error: '', // global errors (list/delete/create), transient
    sessionErrors: {}, // per-session last error, shown when that session displays
    cwd: '',
    home: '',
    cwdPicker: false,
    permissions: {}, // per-session outstanding permission request: sessionId -> request
  });

  #permissionResolves = new Map(); // sessionId -> resolve of the awaited ask
  #chatPaneRef = createRef();
  // Live sessions opened by this panel: id -> { messages, configOptions, cwd }.
  // Switching keeps sessions alive on the host; the cache restores them
  // instantly, and entries are dropped when the host reports a session end.
  #sessionCache = new Map();
  // Loads still running: session id -> { alive }; `alive` is cleared when the
  // session dies so a settling load no longer touches the panel state.
  #pendingLoads = new Map();

  @mounted()
  #boot = async () => {
    try {
      await this.#loadHome();
    } finally {
      this.#s({ booting: false });
    }
  };

  @mounted()
  #setup = () => {
    const compactMediaQuery = matchMedia('(width <= 1280px)');
    this.#s({ compact: compactMediaQuery.matches });
    agentApi.setPermissionHandler(this.#requestPermission);
    agentApi.setSessionEndedHandler((sessionId) => {
      const record = this.#pendingLoads.get(sessionId);
      if (record) record.alive = false;
      this.#sessionCache.delete(sessionId);
      this.#decidePermission(sessionId, null);
      // A load for the displayed session died: stop spinning, the next
      // action surfaces the dead session as an error.
      if (sessionId === this.#s.sessionId) this.#s({ loadingSession: false });
    });
    agentApi.setHostReconnectedHandler(() => {
      // A fresh host process keeps no live sessions; every cached entry and
      // in-flight load is stale. Keep the visible transcript readable, but
      // force a fresh create/load before chatting again.
      for (const sessionId of [...this.#permissionResolves.keys()]) {
        this.#decidePermission(sessionId, null);
      }
      for (const record of this.#pendingLoads.values()) record.alive = false;
      this.#pendingLoads.clear();
      this.#sessionCache.clear();
      this.#s({
        loadingSession: false,
        permissions: {},
        sessionErrors: {},
        ...(this.#s.sessionId && { error: t('devtoolsPanelHostReconnected') }),
      });
    });
    const removeMediaQueryListener = addListener(compactMediaQuery, 'change', this.#updateCompactMode);
    const stopRefreshingSessions = polling(this.#refreshSessions, 5000);
    return () => {
      removeMediaQueryListener();
      stopRefreshingSessions();
      // Decline every awaited permission: the panel cannot answer anymore.
      for (const sessionId of [...this.#permissionResolves.keys()]) {
        this.#decidePermission(sessionId, null);
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
    const sessionId = request?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      return Promise.reject(new Error('Permission request without sessionId'));
    }
    // At most one outstanding request per session: decline a stray old one.
    this.#decidePermission(sessionId, null);
    return new Promise((resolve) => {
      this.#permissionResolves.set(sessionId, resolve);
      this.#s({ permissions: { ...this.#s.permissions, [sessionId]: request } });
    });
  };

  /** Resolve the awaited permission of one session; `null` declines it. */
  #decidePermission = (sessionId, optionId) => {
    if (!sessionId) return;
    const resolve = this.#permissionResolves.get(sessionId);
    if (!resolve && !this.#s.permissions[sessionId]) return;
    this.#permissionResolves.delete(sessionId);
    const permissions = { ...this.#s.permissions };
    delete permissions[sessionId];
    this.#s({ permissions });
    resolve?.(optionId);
  };

  #refreshSessions = async () => {
    try {
      const { sessions } = await agentApi.listSessions();
      this.#s({ sessions: sessions || [], error: '' });
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

  #completeThought = (messages) => {
    const last = messages.at(-1);
    if (last?.type !== 'thought' || !last.pending) return messages;
    const next = messages.slice();
    next[next.length - 1] = { ...last, pending: false };
    return next;
  };

  /** Read/write access to one session's chat state: the live pane when it is
   * the displayed session, otherwise its kept-alive cache entry. */
  #sessionStore = (sessionId) => ({
    get: () => (sessionId === this.#s.sessionId ? this.#s : this.#sessionCache.get(sessionId)),
    set: (patch) => {
      if (sessionId === this.#s.sessionId) {
        this.#s(patch);
      } else if (this.#sessionCache.has(sessionId)) {
        this.#sessionCache.set(sessionId, { ...this.#sessionCache.get(sessionId), ...patch });
      }
    },
  });

  #finishThought = (sessionId) => {
    const store = this.#sessionStore(sessionId);
    const messages = this.#completeThought(store.get()?.messages ?? []);
    if (messages !== store.get()?.messages) store.set({ messages });
  };

  /** Apply one ACP event to the session it belongs to. */
  #applyEvent = (sessionId, event) => {
    if (event.event !== 'session_update') {
      if (event.event === 'stop') this.#finishThought(sessionId);
      return;
    }
    const store = this.#sessionStore(sessionId);
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
    } else {
      // Surface other ACP session updates (tool calls, plans, …) for inspection
      store.set({ messages: [...currentMessages, { type: 'event', data: update }] });
    }
  };

  /** Send one turn; the composer owns the draft and clears it before this. */
  #send = async ({ prompt, attachments }) => {
    const sessionId = this.#s.sessionId;
    if ((!prompt && !attachments.length) || !sessionId || this.#s.pendingIds.includes(sessionId)) return;
    this.#chatPaneRef.value?.scrollToLatest(true);
    const store = this.#sessionStore(sessionId);
    const turnStart = (store.get()?.messages ?? []).length;
    // Wire format: images as base64 blocks; text files wrapped so the agent
    // can tell them apart from the user's own words.
    const wireAttachments = attachments.map((item) =>
      item.kind === 'image'
        ? { type: 'image', data: item.data, mimeType: item.mimeType }
        : { type: 'text', text: `<attachment name="${item.name}">\n${item.text}\n</attachment>` },
    );
    this.#clearSessionError(sessionId);
    this.#setSessionPending(sessionId, true);
    store.set({
      messages: [...(store.get()?.messages ?? []), { role: 'user', text: prompt, attachments }],
    });
    try {
      // The turn keeps running when the user switches away; its events and
      // the final answer follow the session via the store.
      const answer = await agentApi.ask(prompt, {
        sessionId,
        onEvent: (event) => this.#applyEvent(sessionId, event),
        attachments: wireAttachments,
      });
      this.#finishThought(sessionId);
      const messages = store.get()?.messages ?? [];
      const receivedAgentText = messages.slice(turnStart).some((message) => message.role === 'agent' && message.text);
      if (answer && !receivedAgentText) {
        store.set({ messages: [...messages, { role: 'agent', text: answer }] });
      }
      await this.#refreshSessions();
    } catch (e) {
      this.#finishThought(sessionId);
      this.#setSessionError(sessionId, e.message);
    } finally {
      this.#setSessionPending(sessionId, false);
    }
  };

  #cancel = () => {
    const sessionId = this.#s.sessionId;
    // Canceling a turn also declines its awaited permission.
    this.#decidePermission(sessionId, null);
    if (sessionId) {
      agentApi.cancelPrompt(sessionId).catch((e) => this.#setSessionError(sessionId, e.message));
    }
  };

  #newSession = () => {
    this.#s({ cwdPicker: true, error: '' });
  };

  /** Stash the right-pane state of the current session for later reuse. */
  #snapshotSession = () => {
    const sessionId = this.#s.sessionId;
    if (!sessionId) return;
    this.#sessionCache.set(sessionId, {
      messages: this.#completeThought(this.#s.messages),
      configOptions: this.#s.configOptions,
      cwd: this.#s.cwd,
    });
  };

  #setSessionLoading = (sessionId, loading) => {
    const loadingIds = this.#s.loadingIds.filter((id) => id !== sessionId);
    if (loading) loadingIds.push(sessionId);
    this.#s({ loadingIds });
  };

  #setSessionPending = (sessionId, pending) => {
    const pendingIds = this.#s.pendingIds.filter((id) => id !== sessionId);
    if (pending) pendingIds.push(sessionId);
    this.#s({ pendingIds });
  };

  /** Record an error against its session; without one, fall back to global. */
  #setSessionError = (sessionId, message) => {
    if (!sessionId) {
      this.#s({ error: message });
      return;
    }
    this.#s({ sessionErrors: { ...this.#s.sessionErrors, [sessionId]: message } });
  };

  #clearSessionError = (sessionId) => {
    if (!sessionId || !this.#s.sessionErrors[sessionId]) return;
    const sessionErrors = { ...this.#s.sessionErrors };
    delete sessionErrors[sessionId];
    this.#s({ sessionErrors });
  };

  #confirmNewSession = async (cwd) => {
    // Create the ACP session right away so its real config options
    // (mode/model/effort) are selectable before the first message.
    this.#snapshotSession();
    const viewAtStart = this.#s.sessionId;
    this.#s({ loadingSession: true, cwdPicker: false, error: '' });
    try {
      const created = await agentApi.createSession({ cwd, panelContext: getPanelContext() });
      // Previous sessions stay live on the host; switching back reuses them.
      this.#sessionCache.set(created.sessionId, { messages: [], configOptions: created.configOptions || [], cwd });
      // Take over the pane only when the user hasn't switched away meanwhile.
      if (this.#s.sessionId === viewAtStart) {
        this.#s({
          sessionId: created.sessionId,
          messages: [],
          configOptions: created.configOptions || [],
          cwd,
          error: '',
          loadingSession: false,
        });
      }
    } catch (e) {
      this.#s({ error: e.message, ...(this.#s.sessionId === viewAtStart && { loadingSession: false }) });
    }
  };

  #openSession = async (sessionId) => {
    if (sessionId === this.#s.sessionId) return;
    const previous = this.#s.sessionId;
    this.#snapshotSession();
    const selected = this.#s.sessions.find((session) => session.sessionId === sessionId);
    // Still live in this panel: swap in the cached state without a host call.
    // A load still running for it keeps streaming into the pane.
    const cached = this.#sessionCache.get(sessionId);
    if (cached) {
      this.#s({
        sessionId,
        messages: cached.messages,
        configOptions: cached.configOptions,
        cwd: cached.cwd,
        loadingSession: this.#pendingLoads.has(sessionId),
      });
      return;
    }
    // Its load is already running elsewhere: just aim the pane at it.
    if (this.#pendingLoads.has(sessionId)) {
      this.#s({
        sessionId,
        cwd: selected?.cwd || '',
        loadingSession: true,
        messages: [],
        configOptions: [],
      });
      return;
    }
    this.#clearSessionError(sessionId);
    // Clear before load: the replayed history rebuilds via #applyEvent. The
    // load keeps running when the user switches away midway — its events
    // follow the session into the cache.
    this.#s({
      sessionId,
      cwd: selected?.cwd || '',
      loadingSession: true,
      messages: [],
      configOptions: [],
    });
    this.#setSessionLoading(sessionId, true);
    const record = { alive: true };
    this.#pendingLoads.set(sessionId, record);
    try {
      const { sessionId: liveId, configOptions } = await agentApi.loadSession(sessionId, {
        onEvent: (event) => this.#applyEvent(sessionId, event),
        panelContext: getPanelContext(),
      });
      if (!record.alive) return;
      this.#finishThought(liveId);
      if (this.#s.sessionId === liveId) {
        this.#sessionCache.set(liveId, {
          messages: this.#s.messages,
          configOptions: configOptions || [],
          cwd: this.#s.cwd,
        });
        this.#s({ configOptions: configOptions || [], loadingSession: false });
      } else if (this.#sessionCache.has(liveId)) {
        // Settled in the background: fold the result into the cached entry.
        const entry = this.#sessionCache.get(liveId);
        this.#sessionCache.set(liveId, {
          ...entry,
          messages: this.#completeThought(entry.messages),
          configOptions: configOptions || [],
        });
      }
    } catch (e) {
      if (!record.alive) return;
      // The error belongs to this session; it shows when the session does.
      this.#setSessionError(sessionId, e.message);
      if (this.#s.sessionId !== sessionId) return;
      // Revert to the previous session when it is still available.
      const fallback = previous ? this.#sessionCache.get(previous) : null;
      if (fallback) {
        this.#s({
          sessionId: previous,
          messages: fallback.messages,
          configOptions: fallback.configOptions,
          cwd: fallback.cwd,
          loadingSession: false,
        });
      } else {
        this.#s({ loadingSession: false });
      }
    } finally {
      if (this.#pendingLoads.get(sessionId) === record) {
        this.#pendingLoads.delete(sessionId);
        this.#setSessionLoading(sessionId, false);
      }
    }
  };

  #deleteSession = async (sessionId) => {
    // Deleting a session with a load or prompt running would race the actor,
    // so only settle for idle sessions.
    if (this.#s.deleting || this.#s.pendingIds.includes(sessionId) || this.#s.loadingIds.includes(sessionId)) return;
    const isCurrent = this.#s.sessionId === sessionId;
    // Optimistic removal from the list; restored if the host rejects it.
    const previousSessions = this.#s.sessions;
    this.#s({
      deleting: sessionId,
      sessions: previousSessions.filter((session) => session.sessionId !== sessionId),
      ...(isCurrent && { sessionId: null, messages: [], configOptions: [], cwd: '' }),
    });
    try {
      // Live sessions (the current one or kept-alive ones) must disconnect
      // before removing the record
      if (isCurrent || this.#sessionCache.has(sessionId)) await agentApi.closeSession(sessionId).catch(() => {});
      await agentApi.deleteSession(sessionId);
      this.#sessionCache.delete(sessionId);
      this.#clearSessionError(sessionId);
    } catch (err) {
      this.#s({ sessions: previousSessions, error: err.message });
      return;
    } finally {
      this.#s({ deleting: null });
    }
    await this.#refreshSessions();
  };

  #onSessionSelect = (e) => {
    const sessionId = e.detail;
    if (sessionId === '__new__') {
      this.#newSession();
    } else if (sessionId) {
      this.#openSession(sessionId);
    }
  };

  /** Selectable session config options (mode/model/effort/…) for the composer. */
  get #configSelects() {
    return (this.#s.configOptions || []).filter(
      (option) => option.type === 'select' && Array.isArray(option.options) && option.options.length,
    );
  }

  #changeConfig = async (configId, value) => {
    const sessionId = this.#s.sessionId;
    if (!sessionId) return;
    const store = this.#sessionStore(sessionId);
    // Show the pick immediately instead of waiting for the host round-trip.
    const previous = store.get()?.configOptions ?? [];
    this.#clearSessionError(sessionId);
    store.set({ configOptions: withConfigValue(previous, configId, value) });
    try {
      const { configOptions } = await agentApi.setSessionConfigOption(sessionId, configId, value);
      if (Array.isArray(configOptions)) store.set({ configOptions });
    } catch (e) {
      this.#setSessionError(sessionId, e.message);
      // Roll back unless a concurrent update replaced the list meanwhile.
      if (store.get()?.configOptions === withConfigValue(previous, configId, value)) {
        store.set({ configOptions: previous });
      }
    }
  };

  /** Session shown in the right header: prefer the persisted title; a
   * just-created session has neither title nor messages yet. */
  get #currentTitle() {
    const current = this.#s.sessions.find((session) => session.sessionId === this.#s.sessionId);
    return current?.title || (this.#s.messages.length ? this.#s.sessionId : t('devtoolsPanelNewSession'));
  }

  get #currentCwd() {
    const current = this.#s.sessions.find((session) => session.sessionId === this.#s.sessionId);
    return current?.cwd || this.#s.cwd;
  }

  get #recentCwd() {
    const timestamp = (session) => Date.parse(session.updatedAt || '') || 0;
    return (
      this.#s.sessions
        .filter((session) => session.cwd)
        .reduce((recent, session) => (!recent || timestamp(session) > timestamp(recent) ? session : recent), null)
        ?.cwd || this.#s.cwd
    );
  }

  /**
   * Temporary entry pinned to the top of the list: a just-created or loaded
   * session that is not persisted in the list yet.
   */
  get #tempSession() {
    const { sessionId, sessions, cwd, messages, loadingIds } = this.#s;
    if (!sessionId || loadingIds.includes(sessionId) || sessions.some((session) => session.sessionId === sessionId))
      return null;
    return { sessionId, title: messages.length ? sessionId : t('devtoolsPanelNewSession'), cwd, temp: true };
  }

  @template()
  #content = () => {
    const {
      compact,
      sessions,
      sessionId,
      messages,
      booting,
      loadingSession,
      loadingIds,
      deleting,
      error,
      sessionErrors,
      pendingIds,
      permissions,
      cwdPicker,
      home,
    } = this.#s;

    if (booting) {
      return html`
        <div class="grid h-full place-items-center bg-bg text-describe">
          <dy-loading></dy-loading>
        </div>
      `;
    }

    const tempSession = this.#tempSession;
    const visibleMessages = this.showEvents ? messages : messages.filter((message) => message.type !== 'event');
    // Session errors follow their session; a fresh global one wins the banner.
    const bannerError = error || (sessionId ? sessionErrors[sessionId] : '') || '';

    return html`
      <div class=${compact ? 'flex h-full flex-col' : 'flex h-full'}>
        <agent-session-list
          class="contents"
          ?compact=${compact}
          .sessions=${sessions}
          .sessionId=${sessionId}
          .tempSession=${tempSession}
          .home=${home}
          .loadingIds=${loadingIds}
          .pendingIds=${pendingIds}
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
          .sessionId=${sessionId}
          .title=${this.#currentTitle}
          .cwd=${displayHomePath(this.#currentCwd, home)}
          .messages=${visibleMessages}
          .permissionRequest=${sessionId ? permissions[sessionId] : null}
          .bannerError=${bannerError}
          .configOptions=${this.#configSelects}
          .composerDisabled=${pendingIds.includes(sessionId) || loadingIds.includes(sessionId)}
          @send=${(e) => this.#send(e.detail)}
          @cancel=${this.#cancel}
          @configchange=${(e) => this.#changeConfig(e.detail.configId, e.detail.value)}
          @decision=${(e) => this.#decidePermission(sessionId, e.detail)}
          @attacherror=${(e) => this.#setSessionError(sessionId, e.detail)}
        ></agent-chat-pane>
        <agent-cwd-modal
          v-if=${cwdPicker}
          .open=${true}
          .customize=${true}
          .maskClosable=${true}
          @close=${() => this.#s({ cwdPicker: false })}
        >
          <agent-cwd-picker
            class="block w-[calc(100vw-2rem)] max-w-2xl"
            .complete=${(value) => agentApi.completeCwd(value)}
            .initialValue=${displayHomePath(this.#recentCwd, home)}
            .home=${home}
            @confirm=${(event) => this.#confirmNewSession(event.detail)}
          ></agent-cwd-picker>
        </agent-cwd-modal>
      </div>
    `;
  };
}
