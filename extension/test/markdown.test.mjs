import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMarkdownExtensions } from '../shared/markdown.js';

let tableCall;
const defaultMarkdownRenderer = {
  table(token) {
    tableCall = { parser: this.parser, token };
    return '<table>Marked table</table>';
  },
};
const markdownExtensions = createMarkdownExtensions(defaultMarkdownRenderer);
const [{ extensions: latexExtensions, renderer }] = markdownExtensions;
const [blockLatex, inlineLatex] = latexExtensions;

describe('agent markdown renderers', () => {
  it('tokenizes and renders dollar and LaTeX delimiters', () => {
    const inlineDollar = inlineLatex.tokenizer('$E = mc^2$');
    const inlineParenthesis = inlineLatex.tokenizer('\\(a + b\\)');
    const blockDollar = blockLatex.tokenizer('$$\n\\frac{a}{b}\n$$\n');
    const blockBracket = blockLatex.tokenizer('\\[x^2\\]');

    assert.equal(inlineLatex.renderer(inlineDollar), '<gem-bind-latex>E = mc^2</gem-bind-latex>');
    assert.equal(inlineLatex.renderer(inlineParenthesis), '<gem-bind-latex>a + b</gem-bind-latex>');
    assert.equal(
      blockLatex.renderer(blockDollar),
      '<gem-bind-latex block tabindex="0">\\frac{a}{b}</gem-bind-latex>\n',
    );
    assert.equal(blockLatex.renderer(blockBracket), '<gem-bind-latex block tabindex="0">x^2</gem-bind-latex>\n');
  });

  it('routes Mermaid and TeX fences to their custom elements', () => {
    const mermaid = renderer.code({ lang: 'mermaid', text: 'flowchart LR\nA --> B' });
    const latex = renderer.code({ lang: 'tex', text: 'x < y' });

    assert.equal(mermaid, '<gem-bind-mermaid tabindex="0">flowchart LR\nA --&gt; B</gem-bind-mermaid>');
    assert.equal(latex, '<gem-bind-latex block tabindex="0">x &lt; y</gem-bind-latex>');
  });

  it('keeps other fenced code on dy-code-block and escapes its source', () => {
    const output = renderer.code({ lang: 'html', text: '</dy-code-block><script>bad()</script>' });

    assert.match(output, /<dy-code-block codelang="html">/);
    assert.doesNotMatch(output, /<script>/);
    assert.match(output, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  });

  it('parses startLine:endLine:filepath fence info into file extension codelang', () => {
    const output = renderer.code({
      lang: '104:111:packages/gem-book/docs/zh/003-plugins.md',
      text: '# Plugins',
    });

    assert.match(output, /<dy-code-block codelang="md">/);
    assert.match(output, /# Plugins/);
  });

  it('parses file:///path:line:col fence info into file extension codelang', () => {
    const output = renderer.code({
      lang: 'file:///Users/foo/bar.ts:10:5',
      text: 'const x = 1',
    });

    assert.match(output, /<dy-code-block codelang="ts">/);
    assert.match(output, /const x = 1/);
  });

  it('parses relative path:line:col fence info into file extension codelang', () => {
    const output = renderer.code({
      lang: 'foo/bar.ts:10:5',
      text: 'const x = 1',
    });

    assert.match(output, /<dy-code-block codelang="ts">/);
  });

  it('parses Windows file URI fence info into file extension codelang', () => {
    const output = renderer.code({
      lang: 'file:///C:/Users/foo/bar.py:42:1',
      text: 'print("hi")',
    });

    assert.match(output, /<dy-code-block codelang="py">/);
  });

  it('wraps tables rendered by the injected Marked renderer', () => {
    const parser = { parseInline: (tokens) => tokens.map((token) => token.text).join('') };
    const token = {
      header: [{ header: true, align: 'left', tokens: [{ text: 'Name' }] }],
      rows: [[{ header: false, align: null, tokens: [{ text: 'Mermaid' }] }]],
    };
    const output = renderer.table.call({ parser }, token);

    assert.equal(output, '<div class="table-scroll" tabindex="0"><table>Marked table</table></div>');
    assert.deepEqual(tableCall, { parser, token });
  });
});
