import { createAgentApi } from '../shared/agent-api.js';
import { setPageI18n, t } from '../shared/i18n.js';
import { displayHomePath } from '../shared/path.js';
import { mountAgentApi, mountBootstrap, mountCompactMode, mountStoredState } from './agent-panel/effects.js';
import { createSessionController } from './agent-panel/session-controller.js';
import { createSessionRuntime } from './agent-panel/session-runtime.js';
import { createTurnController } from './agent-panel/turn-controller.js';

setPageI18n();

const agentApi = createAgentApi();

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
    agents: [], // supported ACP agents reported by the Native Host
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

  #chatPaneRef = createRef();
  #runtime = createSessionRuntime(this.#s);
  #turns = createTurnController({
    state: this.#s,
    runtime: this.#runtime,
    api: agentApi,
    scrollToLatest: () => this.#chatPaneRef.value?.scrollToLatest(true),
    startDraftTurn: (...args) => this.#sessions.startDraftTurn(...args),
  });
  #sessions = createSessionController({
    state: this.#s,
    runtime: this.#runtime,
    turns: this.#turns,
    api: agentApi,
  });

  @effect(() => [])
  #bootstrap = () => mountBootstrap({ state: this.#s, api: agentApi });

  @effect(() => [])
  #observeStoredState = () => mountStoredState(this.#s);

  @effect(() => [])
  #observeCompactMode = () => mountCompactMode(this.#s);

  @effect(() => [])
  #bindAgentApi = () => mountAgentApi({ api: agentApi, sessions: this.#sessions, turns: this.#turns });

  /** Selectable session config options (mode/model/effort/…) for the composer. */
  get #configSelects() {
    const agent = this.#runtime.record(this.#s.sessionKey)?.agent;
    return (this.#s.configOptions || []).filter(
      (option) =>
        option.type === 'select' &&
        Array.isArray(option.options) &&
        option.options.length &&
        !(agent === 'codex' && option.id === 'fast-mode'),
    );
  }

  get #currentTitle() {
    return this.#runtime.record(this.#s.sessionKey)?.title || t('devtoolsPanelNewSession');
  }

  get #recentCwd() {
    const timestamp = (session) => Date.parse(session.updatedAt || '') || 0;
    return (
      this.#runtime
        .list()
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
    const loadingSession = loadingIds.includes(sessionKey) && !this.#runtime.record(sessionKey)?.draft;
    const bannerError = error || (sessionKey ? sessionErrors[sessionKey] : '') || '';
    const initialAgent = agents.some((agent) => agent.id === defaults.agent) ? defaults.agent : agents[0]?.id;

    return html`
      <div class=${compact ? 'flex h-full flex-col' : 'flex h-full'}>
        <agent-session-list
          class="contents"
          ?compact=${compact}
          .sessions=${this.#runtime.list()}
          .sessionKey=${sessionKey}
          .home=${home}
          .loadingIds=${loadingIds}
          .deleting=${deleting}
          @select=${(e) => this.#sessions.openSession(e.detail)}
          @create=${this.#sessions.openNewSession}
          @remove=${(e) => this.#sessions.deleteSession(e.detail)}
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
          @send=${(e) => this.#turns.send(e.detail)}
          @cancel=${this.#turns.cancel}
          @configchange=${(e) => this.#sessions.changeConfig(e.detail.configId, e.detail.value)}
          @decision=${(e) => this.#turns.decidePermission(sessionKey, e.detail)}
          @attacherror=${(e) => this.#runtime.setError(sessionKey, e.detail)}
          @queuesend=${(e) => this.#turns.flushQueued(sessionKey, e.detail)}
          @queueupdate=${(e) => this.#turns.updateQueued(sessionKey, e.detail)}
          @queueremove=${(e) => this.#turns.removeQueued(sessionKey, e.detail)}
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
            @confirm=${(event) => this.#sessions.confirmNewSession(event.detail)}
          ></agent-new-session-picker>
        </agent-new-session-modal>
      </div>
    `;
  };
}
