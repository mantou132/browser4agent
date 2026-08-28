const escapeHtml = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const firstIndex = (...values) => {
  const indexes = values.filter((value) => value >= 0);
  return indexes.length ? Math.min(...indexes) : undefined;
};

const blockLatex = {
  name: 'latexBlock',
  level: 'block',
  start(source) {
    const match = /(?:^|\n)(?:\$\$|\\\[)/.exec(source);
    if (!match) return;
    return match.index + (match[0].startsWith('\n') ? 1 : 0);
  },
  tokenizer(source) {
    const dollar = /^\$\$[ \t]*\n?([\s\S]*?)\n?[ \t]*\$\$(?:[ \t]*(?:\n|$))/.exec(source);
    const bracket = /^\\\[[ \t]*\n?([\s\S]*?)\n?[ \t]*\\\](?:[ \t]*(?:\n|$))/.exec(source);
    const match = dollar || bracket;
    if (!match?.[1]?.trim()) return;
    return { type: 'latexBlock', raw: match[0], text: match[1].trim() };
  },
  renderer({ text }) {
    return `<gem-bind-latex block tabindex="0">${escapeHtml(text)}</gem-bind-latex>\n`;
  },
};

const inlineLatex = {
  name: 'latexInline',
  level: 'inline',
  start: (source) => firstIndex(source.indexOf('$'), source.indexOf('\\(')),
  tokenizer(source) {
    const dollar = /^\$(?!\$|\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\$)/.exec(source);
    const parenthesis = /^\\\((?!\s)([^\n]*?)(?<!\s)\\\)/.exec(source);
    const match = dollar || parenthesis;
    if (!match?.[1]) return;
    return { type: 'latexInline', raw: match[0], text: match[1] };
  },
  renderer({ text }) {
    return `<gem-bind-latex>${escapeHtml(text)}</gem-bind-latex>`;
  },
};

export const createMarkdownExtensions = (defaultMarkdownRenderer) => [
  {
    gfm: true,
    breaks: true,
    extensions: [blockLatex, inlineLatex],
    renderer: {
      link({ href, title, tokens }) {
        // TODO：默认编辑器中打开本地文件
        const label = this.parser.parseInline(tokens);
        const titleAttribute = title ? `title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" ${titleAttribute}>${label}</a>`;
      },
      code({ text, lang }) {
        const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
        const source = escapeHtml(text);
        if (language === 'mermaid') return `<gem-bind-mermaid tabindex="0">${source}</gem-bind-mermaid>`;
        if (['latex', 'tex', 'math'].includes(language)) {
          return `<gem-bind-latex block tabindex="0">${source}</gem-bind-latex>`;
        }
        return `<dy-code-block ${language ? `codelang="${escapeHtml(language)}"` : ''}>${source}</dy-code-block>`;
      },
      table(token) {
        const table = defaultMarkdownRenderer.table.call(this, token);
        return `<div class="table-scroll" tabindex="0">${table}</div>`;
      },
    },
  },
];

export { escapeHtml };
