// Installed into the QuickJS sandbox via Function.toString(), so it must stay
// self-contained: no imports, no closure variables — only the __invoke /
// __timerSet / __timerClear natives the host registers beforehand. The build
// excludes this file from swc for the same reason (see extension.config.mjs).
export function installSandboxApi() {
  const parseResult = (json) => (json == null ? undefined : JSON.parse(json));
  const call = (path, args) => {
    const result = globalThis.__invoke(path, JSON.stringify(args));
    return result && typeof result.then === 'function' ? result.then(parseResult) : parseResult(result);
  };

  // One proxy factory for every pull-style namespace: property access builds
  // the dotted path, calling it routes through the single host bridge.
  const createApiProxy = (pathPrefix) =>
    new Proxy(() => {}, {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        return createApiProxy(pathPrefix ? `${pathPrefix}.${prop}` : String(prop));
      },
      apply: (_target, _thisArg, args) => call(pathPrefix, args),
    });

  globalThis.chrome = createApiProxy('chrome');
  globalThis.browser = createApiProxy('browser');
  globalThis.debuggerEvents = (...args) => call('debuggerEvents', args);

  // console output is captured and handed back with the tool result as `logs`.
  const logs = [];
  const format = (value) => {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  globalThis.console = Object.fromEntries(
    ['debug', 'info', 'log', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level === 'log' ? '' : `[${level}] `}${args.map(format).join(' ')}`),
    ]),
  );
  globalThis.__getLogs = () => JSON.stringify(logs);

  // Timer callbacks live in this registry; the host only owns wall-clock
  // scheduling. __fireTimer is the push entry the host calls on expiry.
  const timers = new Map();
  let nextId = 0;
  const setTimer = (fn, delay, repeat) => {
    if (typeof fn !== 'function') throw new TypeError('Timer callback must be a function');
    const id = ++nextId;
    timers.set(id, [fn, repeat]);
    globalThis.__timerSet(id, Math.max(0, Number(delay) || 0), repeat);
    return id;
  };
  globalThis.setTimeout = (fn, delay) => setTimer(fn, delay, false);
  globalThis.setInterval = (fn, delay) => setTimer(fn, delay, true);
  globalThis.clearTimeout = globalThis.clearInterval = (id) => {
    id = Number(id);
    if (!timers.delete(id)) return;
    globalThis.__timerClear(id);
  };
  globalThis.__fireTimer = (id) => {
    id = Number(id);
    const entry = timers.get(id);
    if (!entry) return;
    if (!entry[1]) timers.delete(id);
    try {
      entry[0]();
    } catch (e) {
      console.error(e?.message || String(e));
    }
  };

  globalThis.queueMicrotask = (fn) =>
    Promise.resolve()
      .then(fn)
      .catch((e) => console.error(e?.message || String(e)));

  // Read-oriented subset of URL: enough for scripts to dissect http(s) URLs.
  const decodeParam = (text) => decodeURIComponent(String(text).replace(/\+/g, '%20'));
  class URLSearchParams {
    #pairs = [];
    constructor(init) {
      if (typeof init === 'object' && init !== null) {
        for (const [name, value] of Array.isArray(init) ? init : Object.entries(init)) this.append(name, value);
      } else if (init != null && init !== '') {
        for (const part of String(init).replace(/^\?/, '').split('&')) {
          if (!part) continue;
          const eq = part.indexOf('=');
          this.append(decodeParam(eq < 0 ? part : part.slice(0, eq)), decodeParam(eq < 0 ? '' : part.slice(eq + 1)));
        }
      }
    }
    append(name, value) {
      this.#pairs.push([String(name), String(value)]);
    }
    delete(name) {
      name = String(name);
      this.#pairs = this.#pairs.filter((pair) => pair[0] !== name);
    }
    get(name) {
      name = String(name);
      const found = this.#pairs.find((pair) => pair[0] === name);
      return found ? found[1] : null;
    }
    getAll(name) {
      name = String(name);
      return this.#pairs.filter((pair) => pair[0] === name).map((pair) => pair[1]);
    }
    has(name) {
      name = String(name);
      return this.#pairs.some((pair) => pair[0] === name);
    }
    set(name, value) {
      name = String(name);
      value = String(value);
      let replaced = false;
      this.#pairs = this.#pairs.flatMap((pair) => {
        if (pair[0] !== name) return [pair];
        if (replaced) return [];
        replaced = true;
        return [[name, value]];
      });
      if (!replaced) this.append(name, value);
    }
    sort() {
      this.#pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    }
    forEach(callback, thisArg) {
      this.#pairs.forEach(([name, value]) => {
        callback.call(thisArg, value, name, this);
      });
    }
    *entries() {
      yield* this.#pairs;
    }
    *keys() {
      for (const [name] of this.#pairs) yield name;
    }
    *values() {
      for (const [, value] of this.#pairs) yield value;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      return this.#pairs.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
    }
  }

  const URL_PATTERN = /^([a-z][a-z\d+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
  class URL {
    constructor(url) {
      const match = URL_PATTERN.exec(String(url));
      if (!match) throw new TypeError(`Invalid URL: ${url}`);
      const [, protocol, authority, pathname = '', search = '', hash = ''] = match;
      let host = authority;
      const at = authority.lastIndexOf('@');
      if (at >= 0) host = authority.slice(at + 1); // credentials are not exposed
      let hostname = host;
      let port = '';
      const bracketEnd = host.indexOf(']');
      if (host[0] === '[' && bracketEnd >= 0) {
        hostname = host.slice(0, bracketEnd + 1);
        port = host.slice(bracketEnd + 1).replace(/^:/, '');
      } else {
        const colon = host.indexOf(':');
        if (colon >= 0) {
          hostname = host.slice(0, colon);
          port = host.slice(colon + 1);
        }
      }
      this.protocol = `${protocol.toLowerCase()}:`;
      this.hostname = hostname.toLowerCase();
      this.port = port;
      this.pathname = pathname || '/';
      this.search = search;
      this.hash = hash;
      this.searchParams = new URLSearchParams(search);
    }
    get host() {
      return this.port ? `${this.hostname}:${this.port}` : this.hostname;
    }
    get origin() {
      return `${this.protocol}//${this.host}`;
    }
    get href() {
      return `${this.protocol}//${this.host}${this.pathname}${this.search}${this.hash}`;
    }
    toString() {
      return this.href;
    }
    toJSON() {
      return this.href;
    }
  }

  globalThis.URLSearchParams = URLSearchParams;
  globalThis.URL = URL;
}
