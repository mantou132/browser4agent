import { GemBindDiff2htmlElement } from '@gem-bind/diff2html';
import { GemBindMarkedElement } from '@gem-bind/marked';
import { theme } from 'duoyun-ui/lib/theme';
import { toolCallDiffs } from '../../shared/diff.js';
import { t } from '../../shared/i18n.js';

import '@gem-bind/diff2html';
import 'duoyun-ui/elements/code-block';

GemBindMarkedElement[Symbol.metadata].adoptedStyleSheets.push(css`
  :host {
    display: block;
    line-height: 1.6;
  }
  p {
    margin: 0;
  }
  p:not(:first-child) {
    margin-top: 0.4rem;
  }
  h1,
  h2,
  h3 {
    margin: 0.65rem 0 0.3rem;
    font-weight: 650;
  }
  h1 {
    font-size: 1.2em;
  }
  h2 {
    font-size: 1.1em;
  }
  ul,
  ol {
    margin: 0.3rem 0;
    padding-left: 1.35rem;
  }
  li + li {
    margin-top: 0.15rem;
  }
  blockquote {
    margin: 0.4rem 0;
    border-left: 3px solid ${theme.borderColor};
    padding-left: 0.75rem;
    color: ${theme.describeColor};
  }
  table {
    display: block;
    max-width: 100%;
    margin: 0.5rem 0;
    overflow-x: auto;
    border-collapse: collapse;
    font-size: 0.9em;
  }
  th,
  td {
    border: 1px solid ${theme.borderColor};
    padding: 0.3rem 0.6rem;
  }
  thead {
    background: ${theme.backgroundColor};
  }
  th:not([align]) {
    text-align: left;
  }
  code {
    border-radius: 3px;
    background: ${theme.backgroundColor};
    padding: 0.1em 0.3em;
    font-size: 0.9em;
    lien-height: 1.4;
    font-family: ${theme.codeFont};
  }
  dy-code-block {
    margin: 0.5rem 0;
    border: 1px solid ${theme.borderColor};
    background: ${theme.backgroundColor};
    /* token 配色只有一套亮色默认值，深色底上不可读：亮色沿用默认值，
       暗色对齐 vendor 的 github-dark（和 diff2html 的 hljs 主题一致）*/
    --code-comment-color: light-dark(#6e6e6e, #8b949e);
    --code-title-color: light-dark(#4646c6, #c9d1d9);
    --code-section-color: light-dark(#c9252d, #7ee787);
    --code-variable-color: light-dark(#ae0e66, #ffa657);
    --code-literal-color: light-dark(#6f38b1, #79c0ff);
    --code-string-color: light-dark(#12805c, #a5d6ff);
    --code-function-color: light-dark(#0d66d0, #d2a8ff);
    --code-keyword-color: light-dark(#93219e, #ff7b72);
    --code-attribute-color: light-dark(#4646c6, #79c0ff);
  }
  a {
    color: ${theme.primaryColor};
    text-decoration: underline;
  }
`);

const diffColorScheme = globalThis.chrome?.devtools?.panels?.themeName === 'dark' ? 'dark' : 'light';

// 工具标题已含文件路径，隐藏 d2h 文件头；
// 元素把自己的样式表排在外来之后，特异性必须高于上游的 .d2h-file-header 才能覆盖
GemBindDiff2htmlElement[Symbol.metadata].adoptedStyleSheets.push(css`
  div.d2h-wrapper {
    .d2h-file-header {
      display: none;
    }
    .d2h-file-wrapper {
      margin-bottom: 0;
      border: none;
    }
    .d2h-code-linenumber {
      border-left: none;
    }
  }
`);

const markdownExtensions = [
  {
    gfm: true,
    breaks: true,
    renderer: {
      link({ href, title, tokens }) {
        // TODO：默认编辑器中打开本地文件
        const label = this.parser.parseInline(tokens);
        const titleAttribute = title ? `title="${title}"` : '';
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" ${titleAttribute}>${label}</a>`;
      },
      code({ text, lang }) {
        const language = (lang || '').trim().split(/\s+/)[0];
        return `<dy-code-block ${language ? `codelang="${language}"` : ''}>${text}</dy-code-block>`;
      },
    },
  },
];

@customElement('agent-message-bubble')
class AgentMessageBubbleElement extends GemElement {
  @property message;

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
          <gem-bind-marked
            class="block wrap-break-word px-2.5 pb-1 leading-relaxed"
            .extensions=${markdownExtensions}
            >${msg.text || ''}</gem-bind-marked
          >
        </details>
      `;
    }

    if (msg.type === 'tool') {
      const { title, kind, status, rawInput } = msg.data || {};
      const diffs = toolCallDiffs(msg.data);
      const toolTitle = title || t('devtoolsToolCall');
      const toolMeta = [kind, status].filter(Boolean).join(' / ');
      return html`
        <details class="my-2 rounded border border-border bg-bg-light/60 text-xs text-describe overflow-hidden">
          <summary class="min-w-0 cursor-pointer select-none px-2.5 py-2 hover:text-text">
            <span class="inline-flex w-[calc(100%_-_1rem)] min-w-0 items-center gap-2 align-middle">
              <span class="min-w-0 flex-1 truncate font-medium text-text" title=${toolTitle}>${toolTitle}</span>
              <span v-if=${toolMeta} class="max-w-[45%] shrink-0 truncate font-mono" title=${toolMeta}
                >${toolMeta}</span
              >
            </span>
          </summary>
          <div v-if=${diffs.length} class="border-t border-border">
            ${diffs.map(
              ({ text }) =>
                html`<gem-bind-diff2html
                  class="relative block w-full overflow-x-auto"
                  .colorScheme=${diffColorScheme}
                  >${text}</gem-bind-diff2html
                >`,
            )}
          </div>
          <div v-if=${!diffs.length && rawInput !== undefined} class="border-t border-border p-2.5">
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
            'max-w-[85%] bg-user-bubble text-white rounded-br-xs': isUser,
            'w-full bg-bg-light text-text border border-border rounded-bl-xs': !isUser,
          })}
        >
          <div v-if=${isUser && msg.attachments?.length} class="mb-1.5 flex flex-wrap justify-end gap-1">
            ${msg.attachments?.map(
              (item) => html`<agent-attachment inverted small .attachment=${item}></agent-attachment>`,
            )}
          </div>
          ${
            isUser
              ? msg.text
              : html`<gem-bind-marked .extensions=${markdownExtensions}>${msg.text || ''}</gem-bind-marked>`
          }</div>
      </div>
    `;
  };
}
