import assert from 'node:assert/strict';
import test from 'node:test';
import { executeScriptInBackground } from '../tools.js';

test('execute_script_in_background sandbox', async (t) => {
  let prevChrome;
  let prevBrowser;
  let prevFetch;

  t.beforeEach(() => {
    prevChrome = globalThis.chrome;
    prevBrowser = globalThis.browser;
    prevFetch = globalThis.fetch;
    globalThis.chrome = {
      runtime: {
        id: 'test-ext',
        getURL: (path) => `chrome-extension://test-ext/${path}`,
      },
    };
    globalThis.browser = undefined;
    globalThis.fetch = undefined;
  });

  t.afterEach(() => {
    globalThis.chrome = prevChrome;
    globalThis.browser = prevBrowser;
    globalThis.fetch = prevFetch;
  });

  const run = (funcStr, args = []) => executeScriptInBackground(funcStr, args);

  await t.test('keeps the vm alive until awaited sleeps resolve', async () => {
    const start = Date.now();
    const res = await run(`async () => {
      await new Promise((r) => setTimeout(r, 120));
      return 'slept';
    }`);
    assert.equal(res.value, 'slept');
    assert.ok(Date.now() - start >= 100);
  });

  await t.test('returns captured console output as logs', async () => {
    const res = await run(`() => {
      console.log('first', 1);
      console.info('second');
      console.warn('third');
      console.error('fourth');
      return 42;
    }`);
    assert.equal(res.value, 42);
    assert.deepEqual(res.logs, [
      { level: 'log', args: ['first', 1] },
      { level: 'info', args: ['second'] },
      { level: 'warn', args: ['third'] },
      { level: 'error', args: ['fourth'] },
    ]);
  });

  await t.test('proxies browser.* through the same bridge as chrome.*', async () => {
    globalThis.chrome.bookmarks = {
      getTree: async () => [{ id: 'root', title: 'Bookmarks' }],
    };
    const res = await run(`async () => {
      const tree = await browser.bookmarks.getTree();
      return tree[0].title;
    }`);
    assert.equal(res.value, 'Bookmarks');
  });

  await t.test('parses URLs', async () => {
    const res = await run(`() => {
      const u = new URL('https://example.com:8080/path/sub?q=1#hash');
      return {
        protocol: u.protocol,
        host: u.host,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
        origin: u.origin,
      };
    }`);
    assert.deepEqual(res.value, {
      protocol: 'https:',
      host: 'example.com:8080',
      pathname: '/path/sub',
      search: '?q=1',
      hash: '#hash',
      origin: 'https://example.com:8080',
    });
  });

  await t.test('supports URLSearchParams round trip and mutation', async () => {
    const res = await run(`() => {
      const sp = new URLSearchParams('a=1&b=2');
      sp.append('c', '3');
      sp.delete('a');
      return {
        hasB: sp.has('b'),
        b: sp.get('b'),
        toString: sp.toString(),
      };
    }`);
    assert.deepEqual(res.value, {
      hasB: true,
      b: '2',
      toString: 'b=2&c=3',
    });
  });

  await t.test('captures errors thrown in queueMicrotask callbacks into logs', async () => {
    const res = await run(`() => {
      queueMicrotask(() => {
        throw new Error('microtask boom');
      });
      return 'ok';
    }`);
    assert.equal(res.value, 'ok');
    assert.equal(res.logs.length, 1);
    assert.equal(res.logs[0].level, 'error');
    assert.match(String(res.logs[0].args[0]), /microtask boom/);
  });

  await t.test('stops intervals once cleared', async () => {
    const res = await run(`async () => {
      let count = 0;
      const id = setInterval(() => { count++; }, 30);
      await new Promise((r) => setTimeout(r, 95));
      clearInterval(id);
      const snapshot = count;
      await new Promise((r) => setTimeout(r, 60));
      return { count, snapshot };
    }`);
    assert.ok(res.value.count >= 2);
    assert.equal(res.value.count, res.value.snapshot);
  });

  await t.test('reports errors thrown inside timer callbacks into logs', async () => {
    const res = await run(`async () => {
      setTimeout(() => {
        throw new Error('timer boom');
      }, 50);
      await new Promise((r) => setTimeout(r, 80));
      return 'done';
    }`);
    assert.equal(res.value, 'done');
    assert.equal(res.logs.length, 1);
    assert.equal(res.logs[0].level, 'error');
    assert.match(String(res.logs[0].args[0]), /timer boom/);
  });

  await t.test('drops pending timers once the function settles', async () => {
    const res = await run(`() => {
      setTimeout(() => {
        console.log('leak');
      }, 100);
      return 'settled';
    }`);
    assert.equal(res.value, 'settled');
    assert.deepEqual(res.logs, []);
  });

  await t.test('supports synchronous debuggerEvents results', async () => {
    const res = await run(`() => {
      const events = debuggerEvents(123);
      return Array.isArray(events);
    }`);
    assert.equal(res.value, true);
  });

  await t.test('supports synchronous and asynchronous host APIs together', async () => {
    globalThis.chrome.bookmarks = {
      getTree: async () => [{ id: '1' }],
    };
    const res = await run(`async () => {
      const url = chrome.runtime.getURL('foo.html');
      const tree = await chrome.bookmarks.getTree();
      return { url, treeLength: tree.length };
    }`);
    assert.deepEqual(res.value, {
      url: 'chrome-extension://test-ext/foo.html',
      treeLength: 1,
    });
  });

  await t.test('propagates script errors together with their logs', async () => {
    let error;
    try {
      await run(`() => {
        console.log('before boom');
        throw new Error('boom');
      }`);
    } catch (e) {
      error = e;
    }
    assert.ok(error);
    assert.match(error.message, /boom/);
    assert.deepEqual(error.logs, [{ level: 'log', args: ['before boom'] }]);
  });

  await t.test('automatically groups created tabs into B4A tab group with quiet background default', async () => {
    const existingGroups = [];
    const updates = [];
    let nextTabId = 7;
    globalThis.chrome.tabs = {
      create: async (createProperties) => {
        return { id: nextTabId++, ...createProperties };
      },
    };
    globalThis.chrome.tabGroups = {
      query: async () => existingGroups,
      update: async (groupId, props) => {
        updates.push({ groupId, ...props });
        return { groupId, ...props };
      },
    };
    globalThis.chrome.tabs.group = async ({ tabIds: _tabIds, groupId, createProperties }) => {
      if (groupId != null) return groupId;
      const newGroup = { id: 101, ...createProperties };
      existingGroups.push({ id: 101, title: 'B4A', ...createProperties });
      return 101;
    };

    // Default call without active defaults to active: false and collapses the group
    const res1 = await run(`async () => await chrome.tabs.create({ url: 'https://a.com' })`);
    assert.equal(res1.value.id, 7);
    assert.equal(res1.value.groupId, 101);
    assert.equal(res1.value.active, false);
    assert.ok(updates.some((u) => u.groupId === 101 && u.title === 'B4A' && u.color === 'blue'));
    assert.ok(updates.some((u) => u.groupId === 101 && u.collapsed === true));

    // Next tab creation joins the existing group
    let joinedExistingGroup = false;
    globalThis.chrome.tabs.group = async ({ tabIds: _tabIds, groupId }) => {
      if (groupId === 101) joinedExistingGroup = true;
      return groupId;
    };
    const res2 = await run(`async () => await chrome.tabs.create({ url: 'https://b.com' })`);
    assert.equal(res2.value.groupId, 101);
    assert.equal(res2.value.active, false);
    assert.equal(joinedExistingGroup, true);

    // Explicit active: true expands the group
    updates.length = 0;
    const res3 = await run(`async () => await chrome.tabs.create({ url: 'https://c.com', active: true })`);
    assert.equal(res3.value.groupId, 101);
    assert.equal(res3.value.active, true);
    assert.ok(updates.some((u) => u.groupId === 101 && u.collapsed === false));
  });
});
