import { addListener } from '@mantou/gem/lib/utils';
import { genIcon, icons } from 'duoyun-ui/lib/icons';
import { polling } from 'duoyun-ui/lib/timer';
import { createAgentApi } from '../shared/agent-api.js';
import { setPageI18n, t } from '../shared/i18n.js';
import { displayHomePath } from '../shared/path.js';

setPageI18n();

const themeName = globalThis.chrome?.devtools?.panels?.themeName;
if (themeName) document.documentElement.style.colorScheme = themeName === 'dark' ? 'dark' : 'light';

const agentApi = createAgentApi();
const sendIcon = genIcon('M5 11h10.17l-4.59-4.59L12 5l7 7-7 7-1.41-1.41L15.17 13H5v-2z');
const stopIcon = genIcon('M7 7h10v10H7z');

function getPanelContext() {
  const tabId = globalThis.chrome?.devtools?.inspectedWindow?.tabId;
  return Number.isInteger(tabId) ? { surface: 'devtools', tabId } : { surface: 'side_panel' };
}

/** Keep the `mode` config option in sync with a `current_mode_update`. */
function withCurrentMode(configOptions, currentModeId) {
  return configOptions.map((option) => (option.id === 'mode' ? { ...option, currentValue: currentModeId } : option));
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
    draft: false, // "new session" was requested but not yet created
    messages: [], // text messages, thought blocks, tool calls, or raw events
    configOptions: [], // current session's ACP config options (mode/model/effort/…)
    pending: false, // prompt in flight
    booting: true, // initial sessions fetching state (whole page loader)
    loadingSession: false, // loading a specific session in the right pane
    loadingId: null, // session id currently being loaded in the left list
    deleting: null, // session id being deleted
    error: '',
    input: '',
    cwd: '',
    home: '',
    cwdPicker: false,
    permissionRequest: null,
  });

  #permissionResolve = null;
  #messagesRef = createRef();
  #followMessages = true;
  #scrollFrame = 0;

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
    const removeMediaQueryListener = addListener(compactMediaQuery, 'change', this.#updateCompactMode);
    const stopRefreshingSessions = polling(this.#refreshSessions, 5000);
    return () => {
      removeMediaQueryListener();
      stopRefreshingSessions();
      cancelAnimationFrame(this.#scrollFrame);
      this.#settlePermission(null);
      agentApi.setPermissionHandler(null);
    };
  };

  #onMessagesScroll = () => {
    const element = this.#messagesRef.value;
    if (!element) return;
    this.#followMessages = element.scrollHeight - element.clientHeight - element.scrollTop <= 32;
  };

  #scrollToLatest = (force = false) => {
    if (force) this.#followMessages = true;
    if (!this.#followMessages) return;
    cancelAnimationFrame(this.#scrollFrame);
    this.#scrollFrame = requestAnimationFrame(() => {
      const element = this.#messagesRef.value;
      if (element) element.scrollTop = element.scrollHeight;
    });
  };

  @effect((element) => [element.#s.messages, element.#s.loadingSession, element.#s.permissionRequest])
  #followLatestMessage = () => {
    if (!this.#s.loadingSession) this.#scrollToLatest();
  };

  #updateCompactMode = ({ matches }) => {
    this.#s({ compact: matches });
  };

  #requestPermission = (request) => {
    this.#settlePermission(null);
    return new Promise((resolve) => {
      this.#permissionResolve = resolve;
      this.#s({ permissionRequest: request });
    });
  };

  #settlePermission = (optionId) => {
    const resolve = this.#permissionResolve;
    this.#permissionResolve = null;
    this.#s({ permissionRequest: null });
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

  #finishThought = () => {
    const messages = this.#completeThought(this.#s.messages);
    if (messages !== this.#s.messages) this.#s({ messages });
  };

  #onEvent = (event) => {
    if (event.event !== 'session_update') {
      if (event.event === 'stop') this.#finishThought();
      return;
    }
    const { update } = event;
    const thoughtChunk = update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text';
    const currentMessages = thoughtChunk ? this.#s.messages : this.#completeThought(this.#s.messages);
    // Text chunks: live turns stream agent chunks; load replays both roles
    const role =
      update.sessionUpdate === 'agent_message_chunk'
        ? 'agent'
        : update.sessionUpdate === 'user_message_chunk'
          ? 'user'
          : null;
    if (role && update.content?.type === 'text') {
      const messages = currentMessages.slice();
      const last = messages.at(-1);
      if (last?.role === role) {
        messages[messages.length - 1] = { ...last, text: last.text + update.content.text };
      } else {
        messages.push({ role, text: update.content.text });
      }
      this.#s({ messages });
    } else if (thoughtChunk) {
      const messages = currentMessages.slice();
      const last = messages.at(-1);
      if (last?.type === 'thought') {
        messages[messages.length - 1] = { ...last, text: last.text + update.content.text, pending: true };
      } else {
        messages.push({ type: 'thought', text: update.content.text, pending: true });
      }
      this.#s({ messages });
    } else if (update.sessionUpdate === 'tool_call') {
      this.#s({ messages: [...currentMessages, { type: 'tool', data: update }] });
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
      this.#s({ messages });
    } else if (update.sessionUpdate === 'current_mode_update') {
      // Selector state, not chat content: keep the mode entry current.
      const configOptions = withCurrentMode(this.#s.configOptions, update.currentModeId);
      this.#s({ configOptions });
    } else if (update.sessionUpdate === 'config_option_update') {
      this.#s({ configOptions: Array.isArray(update.configOptions) ? update.configOptions : [] });
    } else {
      // Surface other ACP session updates (tool calls, plans, …) for inspection
      this.#s({ messages: [...currentMessages, { type: 'event', data: update }] });
    }
  };

  #send = async () => {
    const prompt = this.#s.input.trim();
    if (!prompt || this.#s.pending || this.#s.loadingSession) return;
    this.#scrollToLatest(true);
    const turnStart = this.#s.messages.length;
    this.#s({
      input: '',
      pending: true,
      error: '',
      messages: [...this.#s.messages, { role: 'user', text: prompt }],
    });
    try {
      // Create the session lazily on first send; keep the chat visible while
      // it is being created (`pending` already blocks input and shows cancel),
      // otherwise the whole pane flashes the loading screen.
      let sessionId = this.#s.sessionId;
      if (!sessionId) {
        const created = await agentApi.createSession({ cwd: this.#s.cwd, panelContext: getPanelContext() });
        sessionId = created.sessionId;
        this.#s({ sessionId, draft: false, configOptions: created.configOptions || [] });
      }
      const answer = await agentApi.ask(prompt, { sessionId, onEvent: this.#onEvent });
      this.#finishThought();
      const messages = this.#s.messages;
      const receivedAgentText = messages.slice(turnStart).some((message) => message.role === 'agent' && message.text);
      if (answer && !receivedAgentText) {
        this.#s({ messages: [...messages, { role: 'agent', text: answer }] });
      }
      await this.#refreshSessions();
    } catch (e) {
      this.#finishThought();
      this.#s({ error: e.message });
    } finally {
      this.#s({ pending: false });
    }
  };

  #cancel = () => {
    this.#settlePermission(null);
    if (this.#s.sessionId) {
      agentApi.cancelPrompt(this.#s.sessionId).catch((e) => this.#s({ error: e.message }));
    }
  };

  #newSession = () => {
    if (this.#s.pending || this.#s.loadingSession) return;
    this.#s({ cwdPicker: true, error: '' });
  };

  #confirmNewSession = (cwd) => {
    if (this.#s.sessionId) agentApi.closeSession(this.#s.sessionId).catch(() => {});
    this.#followMessages = true;
    this.#s({ sessionId: null, draft: true, messages: [], configOptions: [], cwd, cwdPicker: false, error: '' });
  };

  #openSession = async (sessionId) => {
    if (this.#s.pending || this.#s.loadingSession || sessionId === this.#s.sessionId) return;
    const previous = this.#s.sessionId;
    const previousMessages = this.#s.messages;
    const previousConfigOptions = this.#s.configOptions;
    const selected = this.#s.sessions.find((session) => session.sessionId === sessionId);
    this.#followMessages = true;
    // Clear before load: the replayed history rebuilds the list via #onEvent
    this.#s({ loadingSession: true, loadingId: sessionId, error: '', messages: [], configOptions: [] });
    try {
      const { sessionId: liveId, configOptions } = await agentApi.loadSession(sessionId, {
        onEvent: this.#onEvent,
        panelContext: getPanelContext(),
      });
      this.#finishThought();
      // Keep the previous live session usable until the replacement succeeds.
      if (previous) await agentApi.closeSession(previous).catch(() => {});
      this.#s({
        sessionId: liveId,
        draft: false,
        cwd: selected?.cwd || '',
        configOptions: configOptions || [],
      });
    } catch (e) {
      this.#s({ error: e.message, messages: previousMessages, configOptions: previousConfigOptions });
    } finally {
      this.#s({ loadingSession: false, loadingId: null });
    }
  };

  #deleteSession = async (sessionId) => {
    if (this.#s.deleting || this.#s.loadingSession || this.#s.pending) return;
    const isCurrent = this.#s.sessionId === sessionId;
    this.#s({ deleting: sessionId });
    try {
      // If it is the live session, disconnect it before removing the record
      if (isCurrent) {
        await agentApi.closeSession(sessionId).catch(() => {});
        this.#s({ sessionId: null, draft: false, messages: [], configOptions: [], cwd: '' });
      }
      await agentApi.deleteSession(sessionId);
      await this.#refreshSessions();
    } catch (err) {
      this.#s({ error: err.message });
    } finally {
      this.#s({ deleting: null });
    }
  };

  #onKeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.#send();
    }
  };

  #onSessionSelect = (e) => {
    const sessionId = e.detail;
    if (sessionId === '__new__') {
      this.#newSession();
    } else if (sessionId) {
      this.#openSession(sessionId);
    }
  };

  /** Selectable session config options (mode/model/effort/…) reported by the agent. */
  get #configSelects() {
    if (this.#s.draft || !this.#s.sessionId) return [];
    return (this.#s.configOptions || []).filter(
      (option) => option.type === 'select' && Array.isArray(option.options) && option.options.length,
    );
  }

  #changeConfig = async (configId, value) => {
    const sessionId = this.#s.sessionId;
    if (!sessionId) return;
    try {
      const { configOptions } = await agentApi.setSessionConfigOption(sessionId, configId, value);
      // A concurrent update may have replaced the list meanwhile.
      if (Array.isArray(configOptions) && sessionId === this.#s.sessionId) this.#s({ configOptions });
    } catch (e) {
      this.#s({ error: e.message });
    }
  };

  /** Whether the right pane has something to chat with (draft or live session). */
  get #canChat() {
    return this.#s.draft || Boolean(this.#s.sessionId);
  }

  /** Session shown in the right header: prefer the persisted title. */
  get #currentTitle() {
    if (this.#s.draft) return t('devtoolsPanelNewSession');
    const current = this.#s.sessions.find((s) => s.sessionId === this.#s.sessionId);
    return current?.title || this.#s.sessionId;
  }

  get #currentCwd() {
    if (this.#s.draft) return this.#s.cwd;
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
   * Temporary entry pinned to the top of the list: the pending draft after
   * "new session", or a just-created session that is not in the persisted
   * list yet.
   */
  get #tempSession() {
    if (this.#s.draft) {
      return { sessionId: null, title: t('devtoolsPanelNewSession'), cwd: this.#s.cwd, temp: true };
    }
    const { sessionId, sessions, cwd } = this.#s;
    if (sessionId && !sessions.some((s) => s.sessionId === sessionId)) {
      return { sessionId, cwd, temp: true };
    }
    return null;
  }

  #isActive = (session) =>
    session ? (this.#s.draft ? Boolean(session.temp) : session.sessionId === this.#s.sessionId) : false;

  @template()
  #content = () => {
    const {
      compact,
      sessions,
      sessionId,
      messages,
      pending,
      booting,
      loadingSession,
      loadingId,
      deleting,
      error,
      input,
      cwdPicker,
      home,
      permissionRequest,
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
    const sessionOptions = [
      ...(tempSession ? [{ label: t('devtoolsPanelNewSession'), value: '__new__' }] : []),
      ...sessions.map((session) => {
        const title = session.title || session.sessionId;
        const cwd = displayHomePath(session.cwd, home);
        return { label: title, description: cwd || undefined, value: session.sessionId };
      }),
    ];

    return html`
      <div class=${compact ? 'flex h-full flex-col' : 'flex h-full'}>
        <aside class=${compact ? 'flex shrink-0 flex-col border-b border-border bg-bg-light/30' : 'flex w-64 shrink-0 flex-col border-r border-border bg-bg-light/30'}>
          <header class=${compact ? 'bg-bg px-3 py-2.5' : 'flex items-center justify-between gap-2 border-b border-border px-3 py-2.5'}>
            <div class="flex w-full items-center justify-between gap-2">
              <dy-picker
                v-if=${compact}
                class="min-w-0 flex-1 font-semibold"
                borderless
                fit
                .options=${sessionOptions}
                .value=${this.#s.draft ? '__new__' : sessionId}
                placeholder=${t('devtoolsPanelNoSessions')}
                @change=${this.#onSessionSelect}
                aria-label=${t('devtoolsPanelSessions')}
              ></dy-picker>
              <span v-else class="font-semibold text-highlight">${t('devtoolsPanelSessions')}</span>
              <div class="flex items-center gap-1">
                <dy-button
                  v-if=${compact && !!sessionId && !pending}
                  small
                  square
                  color="cancel"
                  .icon=${icons.delete}
                  title=${t('devtoolsPanelDelete')}
                  @click=${() => this.#deleteSession(sessionId)}
                ></dy-button>
                <dy-button
                  small
                  .icon=${icons.add}
                  @click=${this.#newSession}
                >
                  ${t('devtoolsPanelNew')}
                </dy-button>
              </div>
            </div>
          </header>
          <ul v-if=${!compact} class="m-0 flex-1 list-none overflow-auto p-0">
            <li
              v-if=${!sessions.length && !tempSession}
              class="px-3 py-4 text-center text-xs text-describe"
            >
              ${t('devtoolsPanelNoSessions')}
            </li>
            <agent-session-item
              v-if=${!!tempSession}
              .session=${tempSession}
              .home=${home}
              ?active=${this.#isActive(tempSession)}
            ></agent-session-item>
            ${sessions.map(
              (session) => html`
                <agent-session-item
                  .session=${session}
                  .home=${home}
                  ?active=${this.#isActive(session)}
                  ?loading=${loadingId === session.sessionId}
                  ?deleting=${deleting === session.sessionId}
                  @select=${() => this.#openSession(session.sessionId)}
                  @delete=${() => this.#deleteSession(session.sessionId)}
                ></agent-session-item>
              `,
            )}
          </ul>
        </aside>
        <section class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
          <header v-if=${!compact && !loadingSession && this.#canChat} class="border-b border-border px-4 py-2.5 bg-bg">
            <span class="block truncate text-sm font-medium text-highlight" title=${sessionId || ''}>
              ${this.#currentTitle}
            </span>
            <span
              v-if=${!!this.#currentCwd}
              class="mt-0.5 block truncate font-mono text-xs text-describe"
              title=${this.#currentCwd}
            >
              ${displayHomePath(this.#currentCwd, home)}
            </span>
          </header>
          <div v-if=${loadingSession} class="grid min-h-0 flex-1 place-items-center text-describe">
            <span class="flex items-center gap-2">
              <dy-loading></dy-loading>
              <span>${t('devtoolsPanelLoading')}</span>
            </span>
          </div>
          <div v-if=${!loadingSession && !this.#canChat} class="grid min-h-0 flex-1 place-items-center text-describe">
            <dy-empty text=${t('devtoolsPanelEmpty')}></dy-empty>
          </div>
          <div
            v-if=${!loadingSession && this.#canChat}
            ${this.#messagesRef}
            class="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-2"
            @scroll=${this.#onMessagesScroll}
          >
            ${visibleMessages.map((msg) => html`<agent-message-bubble .message=${msg}></agent-message-bubble>`)}
            ${
              permissionRequest
                ? html`
                    <agent-permission-request
                      class="sticky bottom-0 z-10 mt-auto block"
                      .request=${permissionRequest}
                      @decision=${(e) => this.#settlePermission(e.detail)}
                    ></agent-permission-request>
                  `
                : null
            }
          </div>
          <div v-if=${error} class="border-t border-negative/30 bg-negative/5 px-4 py-2 text-xs text-negative">${error}</div>
          <footer v-if=${!loadingSession && this.#canChat} class="bg-bg px-4 pb-4 pt-2">
            <div
              class="w-full rounded-lg border border-border bg-bg shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/15"
            >
              <textarea
                class="field-sizing-content box-border block min-h-13 max-h-48 w-full resize-none overflow-y-auto border-0 bg-transparent px-3.5 pb-1 pt-3 text-sm leading-6 text-text outline-none placeholder:text-describe"
                rows="1"
                placeholder=${t('devtoolsPanelPlaceholder')}
                .value=${input}
                @input=${(e) => this.#s({ input: e.target.value })}
                @keydown=${this.#onKeydown}
              ></textarea>
              <div class="flex min-h-10 items-center gap-2 px-2 pb-2">
                <div v-if=${this.#configSelects.length} class="flex min-w-0 flex-wrap items-center gap-1">
                  ${this.#configSelects.map(
                    (option) => html`
                      <dy-picker
                        borderless
                        ?disabled=${pending}
                        class="min-w-0 max-w-40"
                        placeholder=${option.name}
                        .options=${option.options.map((item) => ({
                          label: item.name,
                          description: item.description,
                          value: item.value,
                        }))}
                        .value=${option.currentValue}
                        aria-label=${option.name}
                        title=${option.description || option.name}
                        @change=${(e) => this.#changeConfig(option.id, e.detail)}
                      ></dy-picker>
                    `,
                  )}
                </div>
                <button
                  type="button"
                  class="ml-auto grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-primary text-white transition-[opacity,transform] duration-150 hover:opacity-[.85] active:scale-[.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:bg-disabled disabled:text-describe disabled:hover:opacity-100"
                  ?disabled=${!pending && !input.trim()}
                  title=${pending ? t('devtoolsPanelCancel') : t('devtoolsPanelSend')}
                  aria-label=${pending ? t('devtoolsPanelCancel') : t('devtoolsPanelSend')}
                  @click=${() => (pending ? this.#cancel() : this.#send())}
                >
                  <dy-use class="size-4" .element=${pending ? stopIcon : sendIcon}></dy-use>
                </button>
              </div>
            </div>
          </footer>
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
        </section>
      </div>
    `;
  };
}
