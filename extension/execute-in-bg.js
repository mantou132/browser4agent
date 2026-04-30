import { QJS } from './vendor/quickjs-emscripten.js';

const QuickJSPromise = QJS.getQuickJS();

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

export async function exec(funcStr) {
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

  using promiseHandle = vm.unwrapResult(
    vm.evalCode(`
      (async () => {
        const userFunc = ${funcStr};
        return userFunc();
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
