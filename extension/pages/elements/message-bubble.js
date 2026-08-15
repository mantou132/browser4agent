@customElement('agent-message-bubble')
class AgentMessageBubbleElement extends GemElement {
  @property message;

  @template()
  #content = () => {
    const msg = this.message;
    if (!msg) return html``;

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
