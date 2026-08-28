/**
 * @module Common Page Tools
 * @description 适用于大多数网页的通用读取、填表与点击能力
 * @icon 🌐
 * @author Browser for AI Agent
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function setInputValue(element, value) {
  // textarea 的 value setter 在 HTMLTextAreaElement.prototype 上，用错原型会抛 TypeError
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
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

function setFileInputFiles(element, files) {
  const nativeFilesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set;
  nativeFilesSetter.call(element, files);
}

async function selectAntdOption(searchText) {
  await sleep(1500);

  function findMatch(items) {
    const exact = Array.from(items).find((item) => item.textContent.trim() === searchText);
    if (exact) return exact;
    return Array.from(items).find((item) => item.textContent.trim().includes(searchText));
  }

  const dropdowns = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
  let target = null;
  for (const dd of dropdowns) {
    const items = dd.querySelectorAll('.ant-select-item-option, .ant-select-item-option-grouped');
    target = findMatch(items);
    if (target) break;
  }
  if (!target) {
    const allItems = document.querySelectorAll('.ant-select-item-option, .ant-select-item-option-grouped');
    target = findMatch(allItems);
  }
  if (!target) throw new Error(`下拉未找到 "${searchText}"`);
  target.click();
  await sleep(500);
}

/**
 * 按 label/placeholder/aria-label 模糊匹配并填写输入框
 * @pattern *://*:*\/*
 * @param {{ label: string, value: string }} options
 * @param {string} options.label - 字段标签、placeholder 或 aria-label 中的关键词
 * @param {string} options.value - 要填入的值
 */
export async function fill_field_by_label({ label, value } = {}) {
  if (!label) throw new Error('label is required');
  const key = label.toLowerCase();
  const controls = [
    ...document.deepQuerySelectorAll('>>> input'),
    ...document.deepQuerySelectorAll('>>> textarea'),
    ...document.deepQuerySelectorAll('>>> select'),
    ...document.deepQuerySelectorAll('>>> [contenteditable="true"]'),
  ];
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
  if (target.classList.contains('ant-select-selection-search-input')) {
    await selectAntdOption(value);
  }
  return { label, value: 'value' in target ? target.value : target.textContent, matched: true };
}

/**
 * 将 Base64 内容作为文件写入文件输入控件，并触发 input/change 事件
 * @pattern *://*:*\/*
 * @param {{ label?: string, filename: string, base64: string, mimeType?: string }} options
 * @param {string} [options.label] - 文件控件的 label、aria-label、name 或 id 关键词；页面只有一个文件控件时可省略
 * @param {string} options.filename - 文件名（包含扩展名）
 * @param {string} options.base64 - 文件内容的 Base64 编码（不含 data URL 前缀）
 * @param {string} [options.mimeType=application/octet-stream] - 文件 MIME 类型
 */
export function upload_file({ label, filename, base64, mimeType = 'application/octet-stream' } = {}) {
  if (!filename) throw new Error('filename is required');
  if (typeof base64 !== 'string') throw new Error('base64 is required');

  const inputs = [...document.deepQuerySelectorAll('>>> input[type="file"]')];
  if (!inputs.length) throw new Error('未找到文件输入控件');

  const key = normalize(label).toLowerCase();
  const target = key
    ? inputs.find((element) => {
        const text = [
          element.getAttribute('aria-label'),
          element.getAttribute('name'),
          element.id,
          ...[...(element.labels || [])].map((item) => item.textContent),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return text.includes(key);
      })
    : inputs.length === 1
      ? inputs[0]
      : null;

  if (!target) {
    if (key) throw new Error(`未找到匹配 "${label}" 的文件输入控件`);
    throw new Error(`找到 ${inputs.length} 个文件输入控件，请提供 label`);
  }

  let binary;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('base64 不是有效的 Base64 内容');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  const file = new File([bytes], filename, { type: mimeType });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  setFileInputFiles(target, transfer.files);
  target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

  return { uploaded: true, filename: file.name, size: file.size, type: file.type, url: location.href };
}

/**
 * 按按钮或链接可见文本点击元素
 * @pattern *://*:*\/*
 * @param {{ text: string, exact?: boolean }} options
 * @param {string} options.text - 按钮/链接上的文字
 * @param {boolean} [options.exact=false] - 是否精确匹配
 */
export function click_by_text({ text, exact = false } = {}) {
  if (!text) throw new Error('text is required');
  const nodes = [
    ...document.deepQuerySelectorAll('>>> button'),
    ...document.deepQuerySelectorAll('>>> a'),
    ...document.deepQuerySelectorAll('>>> [role="button"]'),
    ...document.deepQuerySelectorAll('>>> [role="tab"]'),
    ...document.deepQuerySelectorAll('>>> [role="menuitem"]'),
    ...document.deepQuerySelectorAll('>>> [role="link"]'),
    ...document.deepQuerySelectorAll('>>> input[type="button"]'),
    ...document.deepQuerySelectorAll('>>> input[type="submit"]'),
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
 * @pattern *://*:*\/*
 * @param {{ limit?: number }} options
 * @param {number} [options.limit=3] - 最多解析表格数量
 */
export function extract_tables({ limit = 3 } = {}) {
  const tables = [...document.deepQuerySelectorAll('>>> table')].slice(0, limit);
  const data = tables.map((table, index) => {
    const rows = [...table.querySelectorAll('tr')].map((tr) =>
      [...tr.querySelectorAll('th, td')].map((cell) => normalize(cell.innerText)),
    );
    return { index, rows: rows.length, cells: rows };
  });
  return { count: data.length, tables: data, url: location.href };
}
