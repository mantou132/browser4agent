(() => {
  // Injected at document_start to collect page errors.
  window.__page_errors = [];

  function push(type, detail) {
    try {
      window.__page_errors.push({ type, ...detail, time: Date.now() });
    } catch {}
  }

  window.addEventListener('error', (e) => {
    push('error', {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error?.stack,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    push('unhandledrejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  const origError = console.error;
  console.error = (...args) => {
    origError(...args);
    push('console.error', {
      args: args.map((a) => (a instanceof Error ? { message: a.message, stack: a.stack } : String(a))),
    });
  };

  window.addEventListener('securitypolicyviolation', (e) => {
    push('securitypolicyviolation', {
      violatedDirective: e.violatedDirective,
      blockedURI: e.blockedURI,
      documentURI: e.documentURI,
      effectiveDirective: e.effectiveDirective,
      originalPolicy: e.originalPolicy,
    });
  });

  // Hook WebMCP (https://webmachinelearning.github.io/webmcp/) so the extension
  // can list/invoke tools that the page registers via navigator.modelContext.
  // Tool objects (whose `execute` is a non-serializable function) are kept on
  // the page in window.__webmcp_tools__; the extension reads metadata and
  // invokes the live `execute` reference through chrome.scripting.executeScript.
  const tools = new Map();
  window.__webmcp_tools__ = tools;

  try {
    // biome-ignore lint/suspicious/noAssignInExpressions: simple
    const ctx = navigator.modelContext ?? (navigator.modelContext = {});
    const origRegister = ctx.registerTool;
    const origUnregister = ctx.unregisterTool;

    ctx.registerTool = function (tool) {
      const result = origRegister?.call(this, tool);
      if (tool && typeof tool === 'object' && typeof tool.name === 'string') {
        tools.set(tool.name, tool);
      }
      return result;
    };

    ctx.unregisterTool = function (name) {
      tools.delete(name);
      return origUnregister?.call(this, name);
    };
  } catch (e) {
    push('error', { message: `Failed to hook navigator.modelContext: ${e?.message || e}` });
  }

  // Markdown → HTML converter for toolsets (feishu, etc.)
  window.__md2html = (md) => {
    let html = '';
    const lines = md.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.match(/^```/)) {
        const lang = line.slice(3).trim();
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].match(/^```/)) {
          codeLines.push(lines[i].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
          i++;
        }
        html += `<pre><code${lang ? ` class="language-${lang}"` : ''}>${codeLines.join('\n')}</code></pre>`;
        i++;
        continue;
      }
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const lv = headingMatch[1].length;
        html += `<h${lv}>${inl(headingMatch[2])}</h${lv}>`;
        i++;
        continue;
      }
      if (line.match(/^[-*]\s+/)) {
        const items = [];
        while (i < lines.length && lines[i].match(/^[-*]\s+/)) {
          items.push(`<li>${inl(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
          i++;
        }
        html += `<ul>${items.join('')}</ul>`;
        continue;
      }
      if (line.match(/^\d+\.\s+/)) {
        const items = [];
        while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
          items.push(`<li>${inl(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
          i++;
        }
        html += `<ol>${items.join('')}</ol>`;
        continue;
      }
      if (line.trim() === '') {
        i++;
        continue;
      }
      html += `<p>${inl(line)}</p>`;
      i++;
    }
    return html;

    function inl(t) {
      return t
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/~~(.+?)~~/g, '<s>$1</s>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    }
  };

  window.__browser4agentPolicy = trustedTypes.createPolicy('browser4agent', {
    createScript: (s) => s,
    createHTML: (s) => s,
    createScriptURL: (s) => s,
  });

  const _createPolicy = trustedTypes.createPolicy.bind(trustedTypes);
  trustedTypes.createPolicy = (name, rules) => {
    const policy = _createPolicy(name, rules);
    if (!window.__firstPolicy) {
      window.__firstPolicy = policy;
    }
    return policy;
  };

  if (typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = () => {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
  }
})();

// https://www.npmjs.com/package/deep-query-selector?activeTab=code
(() => {
  var t = {};
  function e(t) {
    const e = [];
    for (const r of t) {
      const t = r;
      t.shadowRoot && e.push(t.shadowRoot);
    }
    return e;
  }
  function r(t) {
    return [...t, ...e(t)];
  }
  function n(t) {
    return e(l('*', t));
  }
  function o(t) {
    return [...e(t), ...n(t)];
  }
  function u(t, e) {
    if (!t) return [];
    if (!e.length) return [];
    const r = [];
    r.push(...e.flatMap((e) => [...e.querySelectorAll(t)]));
    const n = t.split(' ').filter((t) => !!t.trim());
    let l = '';
    for (let c = 0; c < n.length; c++) {
      const i = o(0 === c ? e : e.flatMap((t) => [...t.querySelectorAll(l)]));
      0 !== c && r.push(...u(n.slice(c).join(' '), i)), r.push(...u(t, i)), (l = `${l} ${n[c]}`);
    }
    return r;
  }
  function l(t, e) {
    if (!t.trim()) throw new Error(`'${t}' is not a valid selector`);
    if (t.includes('>>>')) {
      const r = t.split('>>>');
      if (r.length > 2) throw new Error('Cannot use multiple `>>>`');
      if (r[1]?.includes('>>')) throw new Error('Cannot use `>>` after `>>>`');
      if (!r[1].trim()) throw new Error('Cannot be empty after `>>>`');
      const n = r[0].trim() ? l(r[0], e) : e,
        o = u(r[1], n);
      return [...new Set(o)];
    }
    {
      const o = t.split('>>');
      if (!o[o.length - 1].trim()) throw new Error('Cannot be empty after `>>`');
      return o.reduce((t, e, u) => {
        if (!e.trim()) return r(t);
        const l = u === o.length - 1;
        return t.flatMap((t) => {
          const o = [...t.querySelectorAll(e)];
          return l ? o : ((t) => [...r(t), ...n(t)])(o);
        });
      }, e);
    }
  }
  function c(t, e) {
    return l(t, e)[0] || null;
  }
  t.d = (e, r) => {
    for (var n in r) t.o(r, n) && !t.o(e, n) && Object.defineProperty(e, n, { enumerable: !0, get: r[n] });
  };
  t.o = (t, e) => Object.hasOwn(t, e);
  Document.prototype.deepQuerySelectorAll = function (t) {
    return l(t, [this]);
  };
  Document.prototype.deepQuerySelector = function (t) {
    return c(t, [this]);
  };
  Element.prototype.deepQuerySelectorAll = function (t) {
    return l(t, [this]);
  };
  Element.prototype.deepQuerySelector = function (t) {
    return c(t, [this]);
  };
  document.deepQuerySelector.bind(document);
  document.deepQuerySelectorAll.bind(document);
})();
