/**
 * @module Common Page Tools
 * @description 适用于大多数网页的通用读取、填表与点击能力
 * @icon 🌐
 * @author Browser for AI Agent
 */

function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function setInputValue(element, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  nativeInputValueSetter.call(element, value);
}

function setControlValue(el, value) {
  if (!el) return false;
  el.focus?.();
  if ('value' in el) {
    setInputValue(el, String(value ?? ''));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value ?? '') }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el.isContentEditable) {
    el.textContent = String(value ?? '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value ?? '') }));
    return true;
  }
  return false;
}

/**
 * 按 label/placeholder/aria-label 模糊匹配并填写输入框
 * @pattern https://*\/*
 * @param {{ label: string, value: string }} options
 * @param {string} options.label - 字段标签、placeholder 或 aria-label 中的关键词
 * @param {string} options.value - 要填入的值
 */
export function fill_field_by_label({ label, value } = {}) {
  if (!label) throw new Error('label is required');
  const key = label.toLowerCase();
  const controls = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')];
  const target = controls.find((el) => {
    const attrs = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.id]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
    const labelText = labelEl?.textContent?.toLowerCase() || '';
    return attrs.includes(key) || labelText.includes(key);
  });
  if (!target) throw new Error(`未找到匹配 "${label}" 的输入控件`);
  setControlValue(target, value);
  return { label, value: 'value' in target ? target.value : target.textContent, matched: true };
}

/**
 * 按按钮或链接可见文本点击元素
 * @pattern https://*\/*
 * @param {{ text: string, exact?: boolean }} options
 * @param {string} options.text - 按钮/链接上的文字
 * @param {boolean} [options.exact=false] - 是否精确匹配
 */
export function click_by_text({ text, exact = false } = {}) {
  if (!text) throw new Error('text is required');
  const nodes = [
    ...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'),
  ];
  const target = nodes.find((el) => {
    const label = normalize(el.textContent || el.value || el.getAttribute('aria-label'));
    return exact ? label === text : label.includes(text);
  });
  if (!target) throw new Error(`未找到文本包含 "${text}" 的可点击元素`);
  target.click();
  return { clicked: true, text: normalize(target.textContent || target.value), url: location.href };
}

/**
 * 提取页面中所有表格为结构化数据
 * @pattern https://*\/*
 * @param {{ limit?: number }} options
 * @param {number} [options.limit=3] - 最多解析表格数量
 */
export function extract_tables({ limit = 3 } = {}) {
  const tables = [...document.querySelectorAll('table')].slice(0, limit);
  const data = tables.map((table, index) => {
    const rows = [...table.querySelectorAll('tr')].map((tr) =>
      [...tr.querySelectorAll('th, td')].map((cell) => normalize(cell.innerText)),
    );
    return { index, rows: rows.length, cells: rows };
  });
  return { count: data.length, tables: data, url: location.href };
}
