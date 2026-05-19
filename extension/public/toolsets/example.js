/**
 * @module Example Page Tools
 * @description 用于测试页面工具订阅、匹配和执行的示例工具集
 * @icon 🧪
 * @author mantou132 <709922234@qq.com>
 */

const DEFAULT_SUMMARY_LENGTH = 300;

function getTextSummary(maxLength) {
  return document.body?.innerText?.trim().slice(0, maxLength) || '';
}

/**
 * 读取当前标签页的标题、URL 和页面文本摘要
 * @pattern https://example.com/*
 * @param {{ maxLength?: number }} options
 * @param {number} [options.maxLength=300] - 返回正文摘要的最大字符数
 */
export function get_page_summary({ maxLength = 300 } = {}) {
  return {
    title: document.title,
    url: location.href,
    summary: getTextSummary(maxLength || DEFAULT_SUMMARY_LENGTH),
  };
}

/**
 * 在当前页面高亮匹配的文本
 * @pattern https://example.com/*
 * @param {{ text: string, color?: string }} options
 * @param {string} options.text - 需要高亮的文本
 * @param {string} [options.color] - CSS 背景色
 */
export function highlight_text({ text, color = 'yellow' } = {}) {
  if (!text) throw new Error('text is required');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let count = 0;
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeValue.includes(text)) nodes.push(node);
  }
  for (const node of nodes) {
    const parts = node.nodeValue.split(text);
    const fragment = document.createDocumentFragment();
    parts.forEach((part, index) => {
      if (part) fragment.append(part);
      if (index < parts.length - 1) {
        const mark = document.createElement('mark');
        mark.textContent = text;
        mark.style.background = color || '';
        fragment.append(mark);
        count++;
      }
    });
    node.parentNode.replaceChild(fragment, node);
  }
  return { count };
}

/**
 * 根据 CSS selector 给输入框赋值并触发 input/change 事件
 * @pattern https://example.com/*
 * @param {{ selector: string, value: string }} options
 * @param {string} options.selector - 输入框 CSS selector
 * @param {string} options.value - 要填写的值
 */
export function fill_input({ selector, value } = {}) {
  if (!selector) throw new Error('selector is required');
  const el = document.querySelector(selector);
  if (!el) throw new Error(`No element found: ${selector}`);
  el.focus?.();
  el.value = value ?? '';
  el.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: String(value ?? ''),
    }),
  );
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selector, value: el.value };
}
