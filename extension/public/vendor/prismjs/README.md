# vendored prismjs@1.26.0

`dy-code-block`（duoyun-ui）运行时按需加载 Prism，但扩展页面 CSP 禁止远程脚本，
所以本地化这份拷贝；版本与 duoyun-ui 内置的 esm.sh 地址一致。

- `index.mjs` = npm 包的 `prism.js`（**1.26.0 没有 `prism.min.js`，别找错文件**），import 时设置 `window.Prism`
- `components/` 来自同版本 `components/*.min.js`，收录常用语言及依赖链；
  未收录的语言由 dy-code-block 优雅降级为纯文本
- 构建期由 `extension/loaders/prism-local.mjs` 把 CDN 地址改写到这里的路径
