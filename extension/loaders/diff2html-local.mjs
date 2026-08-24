// @gem-bind/diff2html 运行时从 jsdelivr/cdnjs fetch 样式，断网会让页面挂掉。
// 构建期把 CDN 地址改写为 public/vendor 下的本地拷贝；
// 上游改写加载方式导致地址消失时直接报错，避免静默失效。
const DIFF_CSS_CDN = `'https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css'`;
const DIFF_CSS_LOCAL = `'/vendor/diff2html/diff2html.min.css'`;
const HLJS_CSS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/styles/';
const HLJS_CSS_LOCAL = '/vendor/highlightjs/';

/** @type {import('webpack').Loader} */
export default function diff2htmlLocal(content) {
  for (const cdn of [DIFF_CSS_CDN, HLJS_CSS_CDN]) {
    if (!content.includes(cdn)) {
      throw new Error('diff2html-local: CDN 地址在 @gem-bind/diff2html 中找不到，上游可能已变更');
    }
  }
  return content.replaceAll(DIFF_CSS_CDN, DIFF_CSS_LOCAL).replaceAll(HLJS_CSS_CDN, HLJS_CSS_LOCAL);
}
