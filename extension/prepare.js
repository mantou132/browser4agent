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
})();
