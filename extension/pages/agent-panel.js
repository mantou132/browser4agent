import { icons } from 'duoyun-ui/lib/icons';
import { createAgentApi } from '../shared/agent-api.js';
import { setPageI18n, t } from '../shared/i18n.js';
import { displayHomePath } from '../shared/path.js';

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
    sessions: [], // persisted sessions: { sessionId, title?, cwd?, updatedAt? }
    sessionId: null, // current live session
    draft: false, // "new session" was requested but not yet created
    messages: [], // text messages, thought blocks, tool calls, or raw events
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

  @mounted()
  #boot = async () => {
    agentApi.setPermissionHandler(this.#requestPermission);
    try {
      await Promise.all([this.#refreshSessions(), this.#loadHome()]);
    } finally {
      this.#s({ booting: false });
    }
  };

  @unmounted()
  #cleanup = () => {
    this.#settlePermission(null);
    agentApi.setPermissionHandler(null);
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
    } else {
      // Surface other ACP session updates (tool calls, plans, …) for inspection
      this.#s({ messages: [...currentMessages, { type: 'event', data: update }] });
    }
  };

  #send = async () => {
    const prompt = this.#s.input.trim();
    if (!prompt || this.#s.pending || this.#s.loadingSession) return;
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
        sessionId = (await agentApi.createSession({ cwd: this.#s.cwd })).sessionId;
        this.#s({ sessionId, draft: false });
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
    this.#s({ sessionId: null, draft: true, messages: [], cwd, cwdPicker: false, error: '' });
  };

  #openSession = async (sessionId) => {
    if (this.#s.pending || this.#s.loadingSession || sessionId === this.#s.sessionId) return;
    const previous = this.#s.sessionId;
    const previousMessages = this.#s.messages;
    const selected = this.#s.sessions.find((session) => session.sessionId === sessionId);
    // Clear before load: the replayed history rebuilds the list via #onEvent
    this.#s({ loadingSession: true, loadingId: sessionId, error: '', messages: [] });
    try {
      const { sessionId: liveId } = await agentApi.loadSession(sessionId, {
        onEvent: this.#onEvent,
      });
      this.#finishThought();
      // Keep the previous live session usable until the replacement succeeds.
      if (previous) await agentApi.closeSession(previous).catch(() => {});
      this.#s({ sessionId: liveId, draft: false, cwd: selected?.cwd || '' });
    } catch (e) {
      this.#s({ error: e.message, messages: previousMessages });
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
        this.#s({ sessionId: null, draft: false, messages: [], cwd: '' });
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

    return html`
      <div class="flex h-full">
        <aside class="flex w-64 shrink-0 flex-col border-r border-border bg-bg-light/30">
          <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <span class="font-semibold text-highlight">${t('devtoolsPanelSessions')}</span>
            <div class="flex items-center gap-1">
              <dy-button
                small
                .icon=${icons.add}
                @click=${this.#newSession}
              >
                ${t('devtoolsPanelNew')}
              </dy-button>
              <dy-button
                small
                square
                color="cancel"
                .icon=${icons.refresh}
                title=${t('devtoolsPanelRefresh')}
                @click=${this.#refreshSessions}
              ></dy-button>
            </div>
          </header>
          <ul class="m-0 flex-1 list-none overflow-auto p-0">
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
        <section class="relative flex min-w-0 flex-1 flex-col bg-bg">
          <header v-if=${!loadingSession && this.#canChat} class="border-b border-border px-4 py-2.5 bg-bg">
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
            class="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-2"
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
          <footer v-if=${!loadingSession && this.#canChat} class="flex items-end gap-2 border-t border-border p-3 bg-bg">
            <dy-input
              type="textarea"
              rows="2"
              class="min-w-0 flex-1"
              placeholder=${t('devtoolsPanelPlaceholder')}
              .value=${input}
              @change=${(e) => this.#s({ input: e.detail })}
              @keydown=${this.#onKeydown}
            ></dy-input>
            <dy-button
              type=${pending ? null : 'solid'}
              color=${pending ? 'cancel' : 'normal'}
              @click=${() => (pending ? this.#cancel() : this.#send())}
            >
              ${pending ? t('devtoolsPanelCancel') : t('devtoolsPanelSend')}
            </dy-button>
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
