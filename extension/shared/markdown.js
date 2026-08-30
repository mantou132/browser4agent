const escapeHtml = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Agent 代码引用围栏信息，codelang 应取文件扩展名：
// - Cursor: startLine:endLine:filepath
// - path:line:col（编译器/终端常见，含 file:/// 绝对路径）
const CODE_REFERENCE_RE = /^(\d+):(\d+):(.+)$/;
const PATH_LOCATION_RE = /^(?!\d+:\d+:)(.+):(\d+):(\d+)$/;

const langFromFilepath = (filepath) => {
  const dot = filepath.lastIndexOf('.');
  return dot > 0 ? filepath.slice(dot + 1).toLowerCase() : '';
};

const resolveCodeLang = (lang) => {
  const token = (lang || '').trim().split(/\s+/)[0];
  const ref = CODE_REFERENCE_RE.exec(token);
  if (ref) return langFromFilepath(ref[3]);
  const location = PATH_LOCATION_RE.exec(token);
  if (location) return langFromFilepath(location[1]);
  return token.toLowerCase();
};

const firstIndex = (...values) => {
  const indexes = values.filter((value) => value >= 0);
  return indexes.length ? Math.min(...indexes) : undefined;
};

const hasClosingFence = (raw) => {
  if (!raw) return true;
  const [openingLine, ...lines] = raw.split(/\r?\n/);
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(openingLine)?.[1];
  if (!fence) return true;
  const closingFence = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
  return lines.some((line) => closingFence.test(line));
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
    if (match) return { type: 'latexBlock', raw: match[0], text: match[1].trim() };
    if (/^(?:\$\$|\\\[)/.test(source)) return { type: 'latexBlock', raw: source, text: '', pending: true };
  },
  renderer({ text, pending }) {
    if (pending) return '';
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
      code({ text, lang, raw }) {
        const language = resolveCodeLang(lang);
        const source = escapeHtml(text);
        if (language === 'mermaid') return `<gem-bind-mermaid tabindex="0">${source}</gem-bind-mermaid>`;
        if (['latex', 'tex', 'math'].includes(language)) {
          return hasClosingFence(raw) ? `<gem-bind-latex block tabindex="0">${source}</gem-bind-latex>` : '';
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
