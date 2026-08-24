# vendored highlight.js theme css

`@gem-bind/diff2html` 开启代码高亮时从 cdnjs fetch 高亮主题（github /
github-dark，按 `colorScheme` 选择），扩展应零远程依赖，所以本地化这两份拷贝；
版本与包内 URL 的 11.8.0 一致。

- 构建期由 `extension/loaders/diff2html-local.mjs` 把 CDN 地址改写到这里的路径
