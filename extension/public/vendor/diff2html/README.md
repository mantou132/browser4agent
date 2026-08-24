# vendored diff2html css

`@gem-bind/diff2html` 运行时从 jsdelivr fetch 样式，扩展应零远程依赖且断网时
顶层 await 会让页面挂掉，所以本地化这份拷贝；版本取自依赖树里的 diff2html
（升级 `@gem-bind/diff2html` 后如样式缺失，从对应 diff2html 包的
`bundles/css/diff2html.min.css` 重新拷贝）。

- 构建期由 `extension/loaders/diff2html-local.mjs` 把 CDN 地址改写到这里的路径
