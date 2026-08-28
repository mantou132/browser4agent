import { t } from '../../shared/i18n.js';

@customElement('agent-chat-pane')
class AgentChatPaneElement extends GemElement {
  @boolattribute compact;
  @boolattribute loadingSession;
  @property sessionKey;
  @property title;
  @property cwd;
  @property messages;
  @property permissionRequest;
  @property bannerError;
  @property agent;
  @property configOptions;
  @property composerDisabled;
  @property queue; // prompts staged while a turn is in flight

  @emitter send;
  @emitter cancel;
  @emitter configchange;
  @emitter decision; // detail: permission optionId (null declines)
  @emitter attacherror;
  @emitter queuesend; // detail: queued item id
  @emitter queueupdate; // detail: { id, prompt, attachments }
  @emitter queueremove; // detail: queued item id

  #messagesRef = createRef();
  #composerRef = createRef();
  #followMessages = true;
  #scrollFrame = 0;

  @effect()
  #clearScrollFrame = () => () => cancelAnimationFrame(this.#scrollFrame);

  /** A new session view starts pinned to the bottom, and the prompt gets
   * focus once it becomes chattable. */
  @effect((i) => [i.sessionKey, i.loadingSession])
  #onSessionViewChange = () => {
    this.#followMessages = true;
    if (!this.sessionKey || this.loadingSession) return;
    this.#composerRef.value?.focus();
  };

  #onMessagesScroll = () => {
    const element = this.#messagesRef.value;
    if (!element) return;
    this.#followMessages = element.scrollHeight - element.clientHeight - element.scrollTop <= 32;
  };

  /** Stick to the latest message unless the user scrolled up; `force`
   * re-enables following (used when the user sends a message). */
  scrollToLatest = (force = false) => {
    if (force) this.#followMessages = true;
    if (!this.#followMessages) return;
    cancelAnimationFrame(this.#scrollFrame);
    this.#scrollFrame = requestAnimationFrame(() => {
      const element = this.#messagesRef.value;
      if (element) element.scrollTop = element.scrollHeight;
    });
  };

  @effect((i) => [i.messages, i.loadingSession, i.permissionRequest])
  #followLatestMessage = () => {
    if (!this.loadingSession) this.scrollToLatest();
  };

  @template()
  #content = () => {
    const {
      compact,
      sessionKey,
      title,
      cwd,
      messages,
      loadingSession,
      permissionRequest,
      bannerError,
      agent,
      configOptions,
      composerDisabled,
      queue,
    } = this;
    const canChat = Boolean(sessionKey);

    return html`
      <section class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
        <header v-if=${!compact && !loadingSession && canChat} class="border-b border-border px-4 py-2.5 bg-bg">
          <span class="block truncate text-sm font-medium text-highlight" title=${sessionKey || ''}>${title}</span>
          <span
            v-if=${!!cwd}
            class="mt-0.5 block truncate font-mono text-xs text-describe"
            title=${cwd}
          >
            ${cwd}
          </span>
        </header>
        <div v-if=${loadingSession} class="grid min-h-0 flex-1 place-items-center text-describe">
          <span class="flex items-center gap-2">
            <dy-loading></dy-loading>
            <span>${t('devtoolsPanelLoading')}</span>
          </span>
        </div>
        <div
          v-if=${!loadingSession && !canChat}
          class="grid min-h-0 flex-1 place-items-center px-8 text-center text-describe"
        >
          <dy-empty text=${t('devtoolsPanelEmpty')}></dy-empty>
        </div>
        <div
          v-if=${!loadingSession && canChat}
          ${this.#messagesRef}
          class="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-2"
          @scroll=${this.#onMessagesScroll}
        >
          ${messages.map((msg) => html`<agent-message-bubble .message=${msg}></agent-message-bubble>`)}
          <agent-permission-request
            v-if=${permissionRequest}
            class="mb-1 mt-2 block"
            .request=${permissionRequest}
            @decision=${(e) => this.decision(e.detail)}
          ></agent-permission-request>
        </div>
        <div v-if=${bannerError} class="border-t border-negative/30 bg-negative/5 px-4 py-2 text-xs text-negative">
          ${bannerError}
        </div>
        <footer v-if=${!loadingSession && canChat} class="bg-bg px-4 pb-4 pt-2">
          <agent-composer
            ${this.#composerRef}
            class="block"
            ?disabled=${composerDisabled}
            .agent=${agent}
            .configOptions=${configOptions}
            .sessionKey=${sessionKey}
            .queue=${queue}
            @send=${(e) => this.send(e.detail)}
            @cancel=${() => this.cancel(null)}
            @configchange=${(e) => this.configchange(e.detail)}
            @attacherror=${(e) => this.attacherror(e.detail)}
            @queuesend=${(e) => this.queuesend(e.detail)}
            @queueupdate=${(e) => this.queueupdate(e.detail)}
            @queueremove=${(e) => this.queueremove(e.detail)}
          ></agent-composer>
        </footer>
      </section>
    `;
  };
}
