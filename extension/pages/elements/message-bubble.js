import { t } from '../../shared/i18n.js';

@customElement('agent-message-bubble')
class AgentMessageBubbleElement extends GemElement {
  @property message;

  @template()
  #content = () => {
    const msg = this.message;
    if (!msg) return html``;

    if (msg.type === 'thought') {
      return html`
        <details class="my-2 border-l-2 border-border pl-3 text-xs text-describe">
          <summary class="cursor-pointer select-none py-1 font-medium text-text">
            <span class="inline-flex items-center gap-1.5">
              <span>${t('devtoolsThought')}</span>
              ${msg.pending ? html`<dy-loading class="size-3 text-describe"></dy-loading>` : null}
            </span>
          </summary>
          <div class="whitespace-pre-wrap break-words pb-1 leading-relaxed">${msg.text}</div>
        </details>
      `;
    }

    if (msg.type === 'tool') {
      const { title, kind, status, rawInput } = msg.data || {};
      return html`
        <details class="my-2 rounded border border-border bg-bg-light/60 text-xs text-describe">
          <summary class="cursor-pointer select-none px-2.5 py-2 hover:text-text">
            <span class="font-medium text-text">${title || t('devtoolsToolCall')}</span>
            <span v-if=${kind || status} class="ml-2 font-mono">${[kind, status].filter(Boolean).join(' / ')}</span>
          </summary>
          ${
            rawInput === undefined
              ? null
              : html`
                  <div class="border-t border-border p-2.5">
                    <div class="mb-1.5 font-medium text-describe">${t('devtoolsToolInput')}</div>
                    <pre class="m-0 overflow-auto rounded bg-bg p-2.5 font-mono leading-relaxed text-text">${JSON.stringify(
                      rawInput,
                      null,
                      2,
                    )}</pre>
                  </div>
                `
          }
        </details>
      `;
    }

    if (msg.type === 'event') {
      const updateName = msg.data?.sessionUpdate || 'event';
      return html`
        <details class="my-2 rounded border border-border bg-bg-light/60 text-xs text-describe">
          <summary class="cursor-pointer select-none px-2.5 py-1.5 hover:text-text font-mono">
            ${updateName}
          </summary>
          <pre class="m-0 overflow-auto border-t border-border bg-bg-light p-2.5 font-mono leading-relaxed">${JSON.stringify(msg.data, null, 2)}</pre>
        </details>
      `;
    }

    const isUser = msg.role === 'user';
    return html`
      <div class=${`my-3 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
        <div
          class=${classMap({
            'max-w-[85%] rounded-lg px-3.5 py-2.5 leading-relaxed break-words whitespace-pre-wrap shadow-sm': true,
            'bg-primary text-white rounded-br-xs': isUser,
            'bg-bg-light text-text border border-border rounded-bl-xs': !isUser,
          })}
        >
          ${msg.text}
        </div>
      </div>
    `;
  };
}
