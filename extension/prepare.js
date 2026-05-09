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

  // TODO: 拦截 window.navigator.modelContext.registerTool 注册的工具
  // 并通过 postMessage 将内容传递给扩展
})();
