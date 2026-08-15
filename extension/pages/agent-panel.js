import { icons } from 'duoyun-ui/lib/icons';
import { createAgentApi } from '../shared/agent-api.js';
import { setPageI18n, t } from '../shared/i18n.js';

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
  #s = createState({
    sessions: [], // persisted sessions: { sessionId, title?, cwd?, mtime? }
    sessionId: null, // current live session
    draft: false, // "new session" was requested but not yet created
    messages: [], // { role: 'user' | 'agent', text } | { type: 'event', data }
    pending: false, // prompt in flight
    booting: true, // initial sessions fetching state (whole page loader)
    loadingSession: false, // loading a specific session in the right pane
    loadingId: null, // session id currently being loaded in the left list
    deleting: null, // session id being deleted
    error: '',
    input: '',
  });

  #listRef = createRef();

  @mounted()
  #boot = async () => {
    try {
      await this.#refreshSessions();
    } finally {
      this.#s({ booting: false });
    }
  };

  @effect((i) => [i.#s.messages])
  #scrollToBottom = () => {
    this.#listRef.current?.scrollTo(0, Number.MAX_SAFE_INTEGER);
  };

  #refreshSessions = async () => {
    try {
      const { sessions } = await agentApi.listSessions();
      this.#s({ sessions: sessions || [] });
    } catch (e) {
      this.#s({ error: e.message });
    }
  };

  #onEvent = (event) => {
    if (event.event !== 'session_update') return;
    const { update } = event;
    // Text chunks: live turns stream agent chunks; load replays both roles
    const role =
      update.sessionUpdate === 'agent_message_chunk'
        ? 'agent'
        : update.sessionUpdate === 'user_message_chunk'
          ? 'user'
          : null;
    if (role && update.content?.type === 'text') {
      const messages = this.#s.messages.slice();
      const last = messages.at(-1);
      if (last?.role === role) last.text += update.content.text;
      else messages.push({ role, text: update.content.text });
      this.#s({ messages });
    } else {
      // Surface other ACP session updates (tool calls, plans, …) for inspection
      this.#s({ messages: [...this.#s.messages, { type: 'event', data: update }] });
    }
  };

  #send = async () => {
    const prompt = this.#s.input.trim();
    if (!prompt || this.#s.pending || this.#s.loadingSession) return;
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
        sessionId = (await agentApi.createSession()).sessionId;
        this.#s({ sessionId, draft: false });
      }
      const answer = await agentApi.ask(prompt, { sessionId, onEvent: this.#onEvent });
      // Fall back to the final answer if chunk events were missed; trailing
      // event entries (usage updates, …) must not hide the streamed bubble
      const messages = this.#s.messages.slice();
      const last = messages.findLast((m) => m.type !== 'event');
      if (last?.role === 'agent') last.text = answer || last.text;
      else if (answer) messages.push({ role: 'agent', text: answer });
      this.#s({ messages });
      await this.#refreshSessions();
    } catch (e) {
      this.#s({ error: e.message });
    } finally {
      this.#s({ pending: false });
    }
  };

  #cancel = () => {
    if (this.#s.sessionId) {
      agentApi.cancelPrompt(this.#s.sessionId).catch((e) => this.#s({ error: e.message }));
    }
  };

  #newSession = () => {
    if (this.#s.pending || this.#s.loadingSession) return;
    if (this.#s.sessionId) agentApi.closeSession(this.#s.sessionId).catch(() => {});
    this.#s({ sessionId: null, draft: true, messages: [], error: '' });
  };

  #openSession = async (sessionId) => {
    if (this.#s.pending || this.#s.loadingSession || sessionId === this.#s.sessionId) return;
    const previous = this.#s.sessionId;
    // Clear before load: the replayed history rebuilds the list via #onEvent
    this.#s({ loadingSession: true, loadingId: sessionId, error: '', messages: [] });
    try {
      // The live session we are leaving is closed; best-effort cleanup
      if (previous) await agentApi.closeSession(previous).catch(() => {});
      const { sessionId: liveId } = await agentApi.loadSession(sessionId, {
        onEvent: this.#onEvent,
      });
      this.#s({ sessionId: liveId, draft: false });
    } catch (e) {
      this.#s({ error: e.message });
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
        this.#s({ sessionId: null, draft: false, messages: [] });
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

  /**
   * Temporary entry pinned to the top of the list: the pending draft after
   * "new session", or a just-created session that is not in the persisted
   * list yet.
   */
  get #tempSession() {
    if (this.#s.draft) return { sessionId: null, title: t('devtoolsPanelNewSession'), temp: true };
    const { sessionId, sessions } = this.#s;
    if (sessionId && !sessions.some((s) => s.sessionId === sessionId)) {
      return { sessionId, temp: true };
    }
    return null;
  }

  #isActive = (session) => (session ? (this.#s.draft ? Boolean(session.temp) : session.sessionId === this.#s.sessionId) : false);

  @template()
  #content = () => {
    const { sessions, sessionId, messages, pending, booting, loadingSession, loadingId, deleting, error, input } =
      this.#s;

    if (booting) {
      return html`
        <div class="grid h-full place-items-center bg-bg text-describe">
          <dy-loading></dy-loading>
        </div>
      `;
    }

    const tempSession = this.#tempSession;

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
              ?active=${this.#isActive(tempSession)}
            ></agent-session-item>
            ${sessions.map(
              (session) => html`
                <agent-session-item
                  .session=${session}
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
        <section class="flex min-w-0 flex-1 flex-col bg-bg">
          <header v-if=${!loadingSession && this.#canChat} class="border-b border-border px-4 py-2.5 bg-bg">
            <span class="block truncate text-xs font-medium text-describe" title=${sessionId || ''}>
              ${this.#currentTitle}
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
          <div v-if=${!loadingSession && this.#canChat} ${this.#listRef} class="min-h-0 flex-1 overflow-auto px-4 py-2">
            ${messages.map((msg) => html`<agent-message-bubble .message=${msg}></agent-message-bubble>`)}
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
              type=${pending ? 'reverse' : 'solid'}
              color=${pending ? 'cancel' : 'normal'}
              @click=${() => (pending ? this.#cancel() : this.#send())}
            >
              ${pending ? t('devtoolsPanelCancel') : t('devtoolsPanelSend')}
            </dy-button>
          </footer>
        </section>
      </div>
    `;
  };
}
