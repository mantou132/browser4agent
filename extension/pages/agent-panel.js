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
    loading: false, // loading/creating a session
    loadingId: null, // session id currently being loaded in the left list
    deleting: null, // session id being deleted
    error: '',
    input: '',
  });

  #listRef = createRef();

  @mounted()
  #boot = () => this.#refreshSessions();

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
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const messages = this.#s.messages.slice();
      const last = messages.at(-1);
      if (last?.role === 'agent') last.text += update.content.text;
      else messages.push({ role: 'agent', text: update.content.text });
      this.#s({ messages });
    } else {
      // Surface other ACP session updates (tool calls, plans, …) for inspection
      this.#s({ messages: [...this.#s.messages, { type: 'event', data: update }] });
    }
  };

  #send = async () => {
    const prompt = this.#s.input.trim();
    if (!prompt || this.#s.pending || this.#s.loading) return;
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
    if (this.#s.pending || this.#s.loading) return;
    if (this.#s.sessionId) agentApi.closeSession(this.#s.sessionId).catch(() => {});
    this.#s({ sessionId: null, draft: true, messages: [], error: '' });
  };

  #openSession = async (sessionId) => {
    if (this.#s.pending || this.#s.loading || sessionId === this.#s.sessionId) return;
    const previous = this.#s.sessionId;
    this.#s({ loading: true, loadingId: sessionId, error: '' });
    try {
      // The live session we are leaving is closed; best-effort cleanup
      if (previous) await agentApi.closeSession(previous).catch(() => {});
      const { sessionId: liveId } = await agentApi.loadSession(sessionId);
      this.#s({ sessionId: liveId, draft: false, messages: [] });
    } catch (e) {
      this.#s({ error: e.message });
    } finally {
      this.#s({ loading: false, loadingId: null });
    }
  };

  #deleteSession = async (sessionId, e) => {
    e.stopPropagation();
    if (this.#s.deleting || this.#s.loading || this.#s.pending) return;
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

  #isActive = (session) => (this.#s.draft ? session.temp : session.sessionId === this.#s.sessionId);

  #renderSession = (session) => {
    const mtime = session.mtime ? new Date(session.mtime).toLocaleString() : '';
    const active = this.#isActive(session);
    const deleting = this.#s.deleting === session.sessionId;
    const loading = this.#s.loadingId === session.sessionId;
    return html`
      <li
        class=${classMap({
          'flex items-center gap-2 border-b border-border px-3 py-2': true,
          'cursor-pointer hover:bg-bg-hover': !deleting && !loading,
          'bg-bg-hover': active,
          'opacity-60': deleting,
        })}
        title=${session.sessionId || ''}
        @click=${() => !session.temp && !deleting && !loading && this.#openSession(session.sessionId)}
      >
        <span class="min-w-0 flex-1">
          <span class="block truncate text-highlight">${session.title || session.sessionId}</span>
          <span v-if=${mtime} class="block truncate text-xs text-describe">${mtime}</span>
        </span>
        <!-- loading: delete button is replaced by a static loading icon -->
        <dy-use
          v-if=${loading && !deleting}
          class="size-3.5 shrink-0 text-describe"
          .element=${icons.loading}
        ></dy-use>
        <!-- deleting: no icon at all, the item is disabled -->
        <dy-use
          v-if=${!deleting && !loading && !session.temp}
          class="size-3.5 shrink-0 cursor-pointer text-describe hover:text-negative"
          .element=${icons.close}
          title=${t('devtoolsPanelDelete')}
          @click=${(e) => this.#deleteSession(session.sessionId, e)}
        ></dy-use>
      </li>
    `;
  };

  #renderMessage = (msg) => {
    if (msg.type === 'event') {
      return html`
        <details class="my-2 text-xs text-describe">
          <summary class="cursor-pointer select-none">${msg.data.sessionUpdate || 'event'}</summary>
          <pre class="overflow-auto rounded bg-bg-light p-2">${JSON.stringify(msg.data, null, 2)}</pre>
        </details>
      `;
    }
    const isUser = msg.role === 'user';
    return html`
      <div class=${`my-2 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
        <div
          class=${`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 ${
            isUser ? 'bg-primary text-white' : 'bg-bg-light text-text'
          }`}
        >
          ${msg.text}
        </div>
      </div>
    `;
  };

  @template()
  #content = () => {
    const { sessions, sessionId, messages, pending, loading, error, input } = this.#s;
    return html`
      <div class="flex h-full">
        <aside class="flex w-64 shrink-0 flex-col border-r border-border">
          <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span class="font-semibold text-highlight">${t('devtoolsPanelSessions')}</span>
            <span class="flex gap-1">
              <button
                class="rounded border border-border px-2 py-0.5 text-xs text-text hover:bg-bg-hover"
                @click=${this.#newSession}
              >
                ${t('devtoolsPanelNew')}
              </button>
              <button
                class="rounded border border-border px-2 py-0.5 text-xs text-text hover:bg-bg-hover"
                @click=${this.#refreshSessions}
              >
                ${t('devtoolsPanelRefresh')}
              </button>
            </span>
          </header>
          <ul class="m-0 flex-1 list-none overflow-auto p-0">
            <li
              v-if=${!sessions.length && !this.#tempSession}
              class="px-3 py-2 text-describe"
            >
              ${t('devtoolsPanelNoSessions')}
            </li>
            ${this.#tempSession ? this.#renderSession(this.#tempSession) : ''}
            ${sessions.map(this.#renderSession)}
          </ul>
        </aside>
        <section class="flex min-w-0 flex-1 flex-col">
          <header v-if=${!loading && this.#canChat} class="border-b border-border px-3 py-2">
            <span class="block truncate text-xs text-describe" title=${sessionId || ''}>
              ${this.#currentTitle}
            </span>
          </header>
          <div v-if=${loading} class="grid min-h-0 flex-1 place-items-center text-describe">
            <span class="flex items-center gap-2">
              <dy-loading></dy-loading>
              <span>${t('devtoolsPanelLoading')}</span>
            </span>
          </div>
          <div v-if=${!loading && !this.#canChat} class="grid min-h-0 flex-1 place-items-center text-describe">
            ${t('devtoolsPanelEmpty')}
          </div>
          <div v-if=${!loading && this.#canChat} ${this.#listRef} class="min-h-0 flex-1 overflow-auto px-4 py-2">
            ${messages.map(this.#renderMessage)}
          </div>
          <div v-if=${error} class="border-t border-negative px-4 py-2 text-negative">${error}</div>
          <footer v-if=${!loading && this.#canChat} class="flex items-end gap-2 border-t border-border p-3">
            <textarea
              rows="2"
              class="min-w-0 flex-1 resize-none rounded border border-border bg-bg px-2 py-1.5 outline-none focus:border-focus"
              placeholder=${t('devtoolsPanelPlaceholder')}
              .value=${input}
              @input=${(e) => this.#s({ input: e.target.value })}
              @keydown=${this.#onKeydown}
            ></textarea>
            <button
              class="rounded bg-primary px-3 py-1.5 text-white hover:opacity-90"
              @click=${() => (pending ? this.#cancel() : this.#send())}
            >
              ${pending ? t('devtoolsPanelCancel') : t('devtoolsPanelSend')}
            </button>
          </footer>
        </section>
      </div>
    `;
  };
}
