import { getQuickJS } from 'quickjs-emscripten';
import { debuggerSnapshot } from './debugger.js';
import { installSandboxApi } from './sandbox-globals.js';

// quickjs 的 glue 是懒加载分包，Chromium MV3 只允许 SW 安装期间 importScripts；
// 启动时预热，否则首次调用会报
// "importScripts() of new scripts after service worker installation is not allowed"
const QuickJSPromise = getQuickJS();

// Pull-style APIs reachable through the single __invoke bridge besides
// chrome.* / browser.*, keyed by the first path segment.
const handlers = { debuggerEvents: debuggerSnapshot };

function invoke(path, args) {
  const [head, ...rest] = path.split('.');
  let parent = head === 'browser' ? (globalThis.browser ?? chrome) : head === 'chrome' ? chrome : null;
  if (parent) {
    let target = parent;
    for (const part of rest) {
      parent = target;
      target = target?.[part];
    }
    if (typeof target !== 'function') return undefined;
    return target.apply(parent, args);
  }
  const handler = handlers[head];
  if (!handler) throw new Error(`Unknown sandbox API: ${path}`);
  return handler(...args);
}

function serializeResult(result) {
  return JSON.stringify(result !== undefined ? result : null);
}

function addInvokeBridge(vm) {
  using handle = vm.newFunction('__invoke', (pathHandle, argsHandle) => {
    const path = vm.getString(pathHandle);
    const argsStr = vm.getString(argsHandle);
    const args = argsStr ? JSON.parse(argsStr) : [];
    const result = invoke(path, args);
    if (!result || typeof result.then !== 'function') {
      return vm.newString(serializeResult(result));
    }

    const promise = vm.newPromise();
    result
      .then((value) => {
        if (!vm.alive) return;
        using valueHandle = vm.newString(serializeResult(value));
        promise.resolve(valueHandle);
      })
      .catch((err) => {
        if (!vm.alive) return;
        using errHandle = vm.newError(err.message || String(err));
        promise.reject(errHandle);
      })
      .finally(() => {
        if (!vm.alive) return;
        vm.runtime.executePendingJobs();
        promise.dispose();
      });
    return promise.handle;
  });
  vm.setProp(vm.global, '__invoke', handle);
}

// Host-side wall-clock scheduling; the callback registry lives in the VM.
function addTimers(vm) {
  const handles = new Map();
  let settled = false;
  using setHandle = vm.newFunction('__timerSet', (idHandle, delayHandle, repeatHandle) => {
    const id = vm.getNumber(idHandle);
    const delay = Math.max(0, vm.getNumber(delayHandle));
    const repeat = vm.dump(repeatHandle);
    const fire = () => {
      if (!repeat) handles.delete(id);
      if (settled || !vm.alive) return;
      try {
        using fired = vm.unwrapResult(vm.evalCode(`__fireTimer(${id})`));
        vm.runtime.executePendingJobs();
      } catch {
        // Nothing to propagate: the script is gone or the callback already
        // reported its error into the captured console.
      }
    };
    handles.set(id, repeat ? setInterval(fire, delay) : setTimeout(fire, delay));
  });
  using clearHandle = vm.newFunction('__timerClear', (idHandle) => {
    const id = vm.getNumber(idHandle);
    clearTimeout(handles.get(id));
    handles.delete(id);
  });
  vm.setProp(vm.global, '__timerSet', setHandle);
  vm.setProp(vm.global, '__timerClear', clearHandle);
  return {
    handles,
    // Timers landing after settlement are dropped instead of racing the teardown.
    settle() {
      settled = true;
    },
  };
}

export async function exec(funcStr, args) {
  const QuickJS = await QuickJSPromise;
  using vm = QuickJS.newContext();

  addInvokeBridge(vm);
  const timers = addTimers(vm);

  vm.unwrapResult(vm.evalCode(`(${installSandboxApi})()`)).dispose();

  using promiseHandle = vm.unwrapResult(
    vm.evalCode(`
      (async () => {
        const userFunc = ${funcStr};
        return userFunc(...${JSON.stringify(args || [])});
      })()
    `),
  );

  const resolvedResult = await new Promise((resolve) => {
    const pump = setInterval(() => vm.runtime.executePendingJobs());
    vm.resolvePromise(promiseHandle).then((result) => {
      clearInterval(pump);
      resolve(result);
    });
  });

  // Pending timers die with the vm once the script settles.
  timers.settle();
  for (const handle of timers.handles.values()) clearTimeout(handle);
  timers.handles.clear();

  // Read even when the script failed, so agents see what it printed.
  let logs = [];
  {
    using logsHandle = vm.unwrapResult(vm.evalCode('__getLogs()'));
    logs = JSON.parse(vm.getString(logsHandle));
  }

  if (resolvedResult.error) {
    using errHandle = resolvedResult.error;
    const err = vm.dump(errHandle);
    const message = typeof err === 'object' ? (err?.message ?? JSON.stringify(err)) : String(err);
    // Failing scripts' last console output travels with the error.
    throw new Error(logs.length ? `${message}\n${logs.join('\n')}` : message);
  }

  using value = resolvedResult.value;
  return { value: vm.dump(value), logs };
}
