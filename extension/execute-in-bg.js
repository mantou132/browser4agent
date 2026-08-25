import { getQuickJS } from 'quickjs-emscripten';

// quickjs 的 glue 是懒加载分包，Chromium MV3 只允许 SW 安装期间 importScripts；
// 启动时预热，否则首次调用会报
// "importScripts() of new scripts after service worker installation is not allowed"
const QuickJSPromise = getQuickJS();

async function hostChromeInvoke(path, args) {
  const parts = path.split('.');
  let target = chrome;
  let parent = null;

  for (const part of parts) {
    parent = target;
    target = target?.[part];
  }

  if (typeof target !== 'function') return undefined;
  return await target.apply(parent, args);
}

async function addHostInvoke(vm) {
  const hostInvoke = (pathHandle, argsHandle) => {
    const path = vm.getString(pathHandle);
    const argsStr = vm.getString(argsHandle);
    const args = argsStr ? JSON.parse(argsStr) : [];
    const promise = vm.newPromise();
    hostChromeInvoke(path, args)
      .then((result) => {
        if (!vm.alive) return;
        using value = vm.newString(JSON.stringify(result !== undefined ? result : null));
        promise.resolve(value);
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
  };
  using hostInvokeHandle = vm.newFunction('__host_invoke', hostInvoke);
  vm.setProp(vm.global, '__host_invoke', hostInvokeHandle);
}

export async function exec(funcStr, args, globals = {}) {
  const QuickJS = await QuickJSPromise;
  using vm = QuickJS.newContext();

  addHostInvoke(vm);

  vm.unwrapResult(
    vm.evalCode(`
      function createChromeProxy(pathPrefix) {
        return new Proxy(() => {}, {
          get: function(target, prop) {
            if (prop === 'then') return undefined;
            const newPath = pathPrefix ? pathPrefix + '.' + prop : prop;
            return createChromeProxy(newPath);
          },
          apply: async function(target, thisArg, args) {
            const argsStr = JSON.stringify(args);
            const resultStr = await __host_invoke(pathPrefix, argsStr);
            return resultStr ? JSON.parse(resultStr) : undefined;
          }
        });
      }
      globalThis.chrome = createChromeProxy('');
    `),
  ).dispose();

  // Lazy host-data bridges: each entry exposes a `name()` global in the VM,
  // serializing the snapshot only when the script actually calls it. The native
  // function returns the value directly (object ownership transfers to the VM),
  // so no extra JSON.parse wrapper is needed.
  for (const [name, getValue] of Object.entries(globals)) {
    using fn = vm.newFunction(name, (...argHandles) => {
      const args = argHandles.map((handle) => vm.dump(handle));
      return vm.unwrapResult(vm.evalCode(`(${JSON.stringify(getValue(...args))})`));
    });
    vm.setProp(vm.global, name, fn);
  }

  const argsJson = JSON.stringify(args || []);
  using promiseHandle = vm.unwrapResult(
    vm.evalCode(`
      (async () => {
        const userFunc = ${funcStr};
        const args = JSON.parse(${JSON.stringify(argsJson)});
        return userFunc(...args);
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

  if (resolvedResult.error) {
    using errHandle = resolvedResult.error;
    const err = vm.dump(errHandle);
    throw new Error(typeof err === 'object' ? (err?.message ?? JSON.stringify(err)) : String(err));
  }

  using value = resolvedResult.value;
  return vm.dump(value);
}
