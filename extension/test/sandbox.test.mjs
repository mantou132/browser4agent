import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// debugger.js touches chrome.* while loading; a minimal stub is enough.
globalThis.chrome = {
  debugger: null,
  storage: { session: { get: async () => ({}) } },
  tabs: {
    onRemoved: { addListener() {} },
    query: async (query) => [{ id: 42, active: !!query?.active }],
    create: async (props) => ({ id: 7, ...props }),
  },
};

const { exec } = await import('../execute-in-bg.js');

const run = (funcStr, args = []) => exec(funcStr, args);

describe('execute_script_in_background sandbox', () => {
  it('keeps the vm alive until awaited sleeps resolve', async () => {
    const { value } = await run(
      `async () => { const t0 = Date.now(); await new Promise((r) => setTimeout(r, 120)); return Date.now() - t0; }`,
    );
    assert.ok(value >= 120);
  });

  it('returns captured console output as logs', async () => {
    const { logs } = await run(`async () => {
      console.log('hello', { a: 1 });
      console.warn('careful');
      console.info('fyi');
    }`);
    assert.deepEqual(logs, ['hello {"a":1}', '[warn] careful', '[info] fyi']);
  });

  it('proxies browser.* through the same bridge as chrome.*', async () => {
    assert.equal((await run(`async () => (await browser.tabs.query({ active: true }))[0].id`)).value, 42);
    assert.equal((await run(`async () => (await chrome.tabs.create({ url: 'https://x.com' })).id`)).value, 7);
  });

  it('parses URLs', async () => {
    const { value } = await run(
      `async () => {
        const u = new URL('https://user@X.com:8443/a/b?b=2&a=%20z#frag');
        return [u.protocol, u.hostname, u.port, u.host, u.origin, u.pathname, u.search, u.hash, u.href, u.searchParams.get('a')];
      }`,
    );
    assert.deepEqual(value, [
      'https:',
      'x.com',
      '8443',
      'x.com:8443',
      'https://x.com:8443',
      '/a/b',
      '?b=2&a=%20z',
      '#frag',
      'https://x.com:8443/a/b?b=2&a=%20z#frag',
      ' z',
    ]);
  });

  it('supports URLSearchParams round trip and mutation', async () => {
    const { value } = await run(`async () => {
      const sp = new URLSearchParams('?tag=a&tag=b&x=1');
      const before = [sp.get('tag'), sp.getAll('tag'), sp.has('x'), [...sp.entries()]];
      sp.set('tag', 'c');
      sp.append('y', ' ');
      return [before, sp.toString(), new URLSearchParams({ p: 'q r' }).toString()];
    }`);
    assert.deepEqual(value, [
      [
        'a',
        ['a', 'b'],
        true,
        [
          ['tag', 'a'],
          ['tag', 'b'],
          ['x', '1'],
        ],
      ],
      'tag=c&x=1&y=%20',
      'p=q%20r',
    ]);
  });

  it('runs queueMicrotask callbacks in order', async () => {
    const { value } = await run(
      `async () => { const out = []; queueMicrotask(() => out.push(2)); out.push(1); await null; return out; }`,
    );
    assert.deepEqual(value, [1, 2]);
  });

  it('captures errors thrown in queueMicrotask callbacks into logs', async () => {
    const { logs } = await run(`async () => { queueMicrotask(() => { throw new Error('micro-oops'); }); await null; }`);
    assert.deepEqual(logs, ['[error] micro-oops']);
  });

  it('stops intervals once cleared', async () => {
    const { value } = await run(`async () => {
      let count = 0;
      const id = setInterval(() => count++, 25);
      await new Promise((resolve) => setTimeout(resolve, 90));
      clearInterval(id);
      const stopped = count;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return [stopped, count];
    }`);
    assert.ok(value[0] >= 2);
    assert.equal(value[0], value[1]);
  });

  it('reports errors thrown inside timer callbacks into logs', async () => {
    const { logs } = await run(`async () => {
      setTimeout(() => { throw new Error('boom'); });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }`);
    assert.deepEqual(logs, ['[error] boom']);
  });

  it('drops pending timers once the function settles', async () => {
    const r = await run(`async () => { setTimeout(() => console.log('should-not-run'), 100); return 'bye'; }`);
    assert.deepEqual(r, { value: 'bye', logs: [] });
  });

  it('supports synchronous debuggerEvents results', async () => {
    const { value } = await run(`async () => {
      const snapshot = debuggerEvents(123);
      return [snapshot, typeof snapshot?.then];
    }`);
    assert.deepEqual(value, [null, 'undefined']);
  });

  it('still exposes the debuggerEvents global asynchronously', async () => {
    const { value } = await run(`async () => await debuggerEvents(123)`);
    assert.equal(value, null);
  });

  it('supports synchronous and asynchronous host APIs together', async () => {
    const { value } = await run(`async () => {
      const snapshot = debuggerEvents(123);
      const tabs = await chrome.tabs.query({ active: true });
      return [snapshot, tabs[0].id];
    }`);
    assert.deepEqual(value, [null, 42]);
  });

  it('propagates synchronous host API errors', async () => {
    await assert.rejects(
      run(`async () => {
      try { debuggerEvents(); } catch (e) { return e.message; }
      throw new Error('not thrown');
    }`),
      /not thrown/,
    );
  });

  it('propagates script errors together with their logs', async () => {
    await assert.rejects(run(`async () => { console.log('before-crash'); throw new Error('kaput'); }`), (e) => {
      assert.match(e.message, /^kaput/);
      assert.match(e.message, /before-crash/);
      return true;
    });
  });

  it('rejects non-function timer callbacks', async () => {
    await assert.rejects(run(`async () => setTimeout(null)`), /must be a function/);
  });
});
