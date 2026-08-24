// dy-code-block 运行时从 esm.sh 加载 Prism，扩展页面 CSP 不允许远程脚本。
// 构建期把它的 CDN 地址改写为 public/vendor/prismjs 下的本地拷贝；
// 上游升级导致模式消失时直接报错，避免静默失效。
const CDN = `'https://esm.sh/prismjs@v1.26.0'`;
const ROOT_URL = `'/vendor/prismjs'`;
const CORE_URL = `'/vendor/prismjs/index.mjs'`;

/** @type {import('webpack').Loader} */
export default function prismLocal(content) {
  if (!content.includes(CDN)) {
    throw new Error('prism-local: esm.sh 地址在 duoyun-ui/elements/code-block.js 中找不到，上游可能已变更');
  }
  return (
    content
      .replaceAll(CDN, ROOT_URL)
      // 核心 import 是裸的 `import(...prismjs)`，需要指到具体文件
      .replace(/prismjs\)\s*;/, `${CORE_URL});`)
  );
}
