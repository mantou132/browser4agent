import { theme } from 'duoyun-ui/lib/theme';
import { marked } from 'marked';
import { t } from '../../shared/i18n.js';

const style = css`
  :scope {
    .agent-markdown {
      line-height: 1.6;

      &:first-child { margin-top: 0; }
      &:last-child { margin-bottom: 0; }

      p {
        margin: 0;
        &:not(:first-child) { margin-top: 0.4rem; }
      }

      h1, h2, h3 {
        margin: 0.65rem 0 0.3rem;
        font-weight: 650;
      }
      h1 { font-size: 1.2em; }
      h2 { font-size: 1.1em; }

      ul, ol {
        margin: 0.3rem 0;
        padding-left: 1.35rem;
      }
      li + li { margin-top: 0.15rem; }

      blockquote {
        margin: 0.4rem 0;
        border-left: 3px solid ${theme.borderColor};
        padding-left: 0.75rem;
        color: ${theme.describeColor};
      }

      pre {
        margin: 0.5rem 0;
        overflow-x: auto;
        border-radius: 4px;
        background: ${theme.backgroundColor};
        padding: 0.65rem 0.75rem;
      }
      code {
        border-radius: 3px;
        background: ${theme.backgroundColor};
        padding: 0.1em 0.3em;
        font: 0.9em/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      pre code { background: none; padding: 0; }
      a { color: ${theme.primaryColor}; text-decoration: underline; }
    }
  }
`;

const safeUrl = (value) => (/^(?:https?:|mailto:|\/|#)/i.test(value.trim()) ? value.trim() : '#');
const escapeAttribute = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const markdownRenderer = new marked.Renderer();
markdownRenderer.link = function ({ href, title, tokens }) {
  const label = this.parser.parseInline(tokens);
  const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : '';
  return `<a href="${escapeAttribute(safeUrl(href))}" target="_blank" rel="noopener noreferrer"${titleAttribute}>${label}</a>`;
};

const markdownToHtml = (value) =>
  marked.parse(value || '', {
    async: false,
    breaks: true,
    gfm: true,
    html: false,
    renderer: markdownRenderer,
  });

@customElement('agent-message-bubble')
@adoptedStyle(style)
class AgentMessageBubbleElement extends GemElement {
  @property message;

  #markdownRef = createRef();
  #markdownText = '';

  @effect()
  #updateMarkdown = () => {
    const text = this.message?.text || '';
    if (!this.#markdownRef.value || text === this.#markdownText) return;
    this.#markdownText = text;
    this.#markdownRef.value.innerHTML = markdownToHtml(text);
  };

  @template()
  #content = () => {
    const msg = this.message;
    if (!msg) return html``;

    if (msg.type === 'thought') {
      return html`
        <details ?open=${msg.pending} class="my-2 border-l-2 border-border text-xs text-describe">
          <summary class="cursor-pointer select-none px-2.5 py-1 font-medium text-text">
            <span>${t('devtoolsThought')}</span>
          </summary>
          <div ${this.#markdownRef} class="agent-markdown wrap-break-word px-2.5 pb-1 leading-relaxed"></div>
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
          <div v-if=${rawInput !== undefined} class="border-t border-border p-2.5">
            <div class="mb-1.5 font-medium text-describe">${t('devtoolsToolInput')}</div>
            <pre class="m-0 overflow-auto rounded bg-bg p-2.5 font-mono leading-relaxed text-text">${JSON.stringify(
              rawInput,
              null,
              2,
            )}</pre>
          </div>
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
            'rounded-lg px-3.5 py-2.5 leading-relaxed break-words': true,
            'max-w-[85%] bg-primary text-white rounded-br-xs': isUser,
            'w-full bg-bg-light text-text border border-border rounded-bl-xs': !isUser,
          })}
        >
          <div v-if=${isUser && msg.attachments?.length} class="mb-1.5 flex flex-wrap justify-end gap-1">
            ${msg.attachments?.map(
              (item) => html`<agent-attachment inverted small .attachment=${item}></agent-attachment>`,
            )}
          </div>
          ${isUser ? msg.text : html`<div ${this.#markdownRef} class="agent-markdown"></div>`}</div>
      </div>
    `;
  };
}
