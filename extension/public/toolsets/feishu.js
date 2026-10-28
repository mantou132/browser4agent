/**
 * @module Feishu Docs Tools
 * @description 在飞书文档中修改标题、在段落前/后插入或删除段落（支持 Markdown）
 * @icon 📄
 * @author Browser for AI Agent
 */

// window.__md2html() 不会转义正文中夹带的原始 HTML，因此在写入 clipboardData 前
// 需要用白名单方式剔除危险标签/属性，防止脚本注入（XSS）。
function sanitizeHtml(html) {
  const allowedTags = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'P', 'PRE', 'CODE', 'STRONG', 'EM', 'S', 'A', 'META']);
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const el of [...template.content.querySelectorAll('*')]) {
    if (!allowedTags.has(el.tagName)) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const keep =
        (el.tagName === 'A' && name === 'href' && !/^\s*javascript:/i.test(attr.value)) ||
        (el.tagName === 'CODE' && name === 'class') ||
        (el.tagName === 'META' && name === 'charset');
      if (!keep) el.removeAttribute(attr.name);
    }
  }
  return template.innerHTML;
}

async function pasteHTML(zone, md) {
  const rootEditor = document.querySelector('.page-block.root-block[contenteditable="true"]');
  if (!rootEditor) throw new Error('未找到编辑器根节点');

  const html = sanitizeHtml(`<meta charset="utf-8">${window.__md2html(md)}`);
  const text = md;

  const leafSpans = zone.querySelectorAll('span[data-leaf="true"]');
  if (leafSpans.length) {
    zone.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    const firstText = leafSpans[0].firstChild;
    const lastText = leafSpans[leafSpans.length - 1].firstChild;
    if (firstText && lastText) {
      range.setStart(firstText, 0);
      range.setEnd(lastText, lastText.length);
    } else {
      range.selectNodeContents(zone);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    zone.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(zone);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  document.dispatchEvent(new Event('selectionchange'));
  await new Promise((r) => setTimeout(r, 200));

  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type) => {
        if (type === 'text/html') return html;
        if (type === 'text/plain') return text;
        return '';
      },
      types: ['text/html', 'text/plain'],
      items: [],
      files: [],
    },
  });
  rootEditor.dispatchEvent(event);
  await new Promise((r) => setTimeout(r, 300));
}

async function simulateInput(el, text) {
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  const leafSpans = el.querySelectorAll('span[data-leaf="true"]');
  if (leafSpans.length) {
    const firstText = leafSpans[0].firstChild;
    const lastText = leafSpans[leafSpans.length - 1].firstChild;
    if (firstText && lastText) {
      range.setStart(firstText, 0);
      range.setEnd(lastText, lastText.length);
    } else {
      range.selectNodeContents(el);
    }
  } else {
    range.selectNodeContents(el);
  }
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  await new Promise((r) => setTimeout(r, 200));
  document.execCommand('insertText', false, text);
}

/**
 * 修改飞书文档标题
 * @pattern https://*.feishu.cn/*
 * @param {{ title: string }} options
 * @param {string} options.title - 新的文档标题（纯文本）
 */
export async function set_title({ title } = {}) {
  if (!title) throw new Error('title is required');
  const titleZone = document.querySelector('h1.page-block-content .zone-container.text-editor');
  if (!titleZone) throw new Error('未找到飞书文档标题区域');
  const prevTitle = titleZone.textContent.replace(/\u200B/g, '');
  await simulateInput(titleZone, title);
  return { title, prevTitle: prevTitle || null };
}

/**
 * 删除飞书文档中的指定段落
 * @pattern https://*.feishu.cn/*
 * @param {{ paragraph_index?: number, text?: string }} options
 * @param {number} [options.paragraph_index] - 段落索引（0 起始）
 * @param {string} [options.text] - 段落文本（模糊匹配），与 paragraph_index 二选一，优先使用 text
 */
export async function delete_paragraph({ paragraph_index, text } = {}) {
  if (paragraph_index == null && !text) throw new Error('paragraph_index 或 text 至少需要提供一个');

  const bodyZones = [...document.querySelectorAll('.page-block-children .zone-container.text-editor')];
  if (!bodyZones.length) throw new Error('未找到飞书文档正文区域');

  let zone;
  if (text) {
    zone = bodyZones.find((z) => z.textContent.replace(/\u200B/g, '').includes(text));
    if (!zone) throw new Error(`未找到包含 "${text}" 的段落`);
  } else {
    zone = bodyZones[paragraph_index];
    if (!zone) throw new Error(`段落索引 ${paragraph_index} 超出范围（共 ${bodyZones.length} 段）`);
  }

  const deletedContent = zone.textContent.replace(/\u200B/g, '');
  const zoneIndex = bodyZones.indexOf(zone);

  await simulateInput(zone, '');

  // \u6E05\u7A7A\u6587\u672C\u540E\u6BB5\u843D\u5757\u4ECD\u6B8B\u7559\uFF0C\u9009\u4E2D\u7A7A\u5757\u6D3E\u53D1 Backspace \u771F\u6B63\u5220\u9664\uFF1B
  // \u7F16\u8F91\u5668\u72B6\u6001\u540C\u6B65\u662F\u5F02\u6B65\u7684\uFF0C\u4E00\u6B21\u53EF\u80FD\u4E0D\u751F\u6548\uFF0C\u5220\u9664\u540E\u91CD\u65B0\u68C0\u67E5\u5E76\u91CD\u8BD5
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const zones = [...document.querySelectorAll('.page-block-children .zone-container.text-editor')];
    const emptyZone = zones[zoneIndex] ?? zone;
    if (!emptyZone.isConnected || zoneText(emptyZone)) break;
    emptyZone.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(emptyZone);
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((r) => setTimeout(r, 200));
    emptyZone.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        which: 8,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  await new Promise((r) => setTimeout(r, 300));

  return { deletedContent };
}

function zoneText(zone) {
  return zone.textContent.replace(/\u200B/g, '').trim();
}

/**
 * 在指定段落前/后插入新内容（支持 Markdown 格式）
 * @pattern https://*.feishu.cn/*
 * @param {{ before?: string, after?: string, content: string }} options
 * @param {string} [options.before] - 目标段落的文本（模糊匹配），新内容将插入到该段落之前
 * @param {string} [options.after] - 目标段落的文本（模糊匹配），新内容将插入到该段落之后；与 before 二选一
 * @param {string} options.content - Markdown 格式的内容（支持标题/链接/加粗/代码块等）
 */
export async function insert_paragraph({ before, after, content } = {}) {
  if (!content) throw new Error('content is required');
  const hasBefore = before != null && before !== '';
  const hasAfter = after != null && after !== '';
  if (hasBefore && hasAfter) throw new Error('before 与 after 不能同时指定');

  const bodyZones = [...document.querySelectorAll('.page-block-children .zone-container.text-editor')];
  if (!bodyZones.length) throw new Error('未找到飞书文档正文区域');

  const insertAfter = hasAfter;
  const anchorText = insertAfter ? after : before;

  let targetZone;
  if (hasBefore || hasAfter) {
    targetZone = bodyZones.find((z) => z.textContent.replace(/\u200B/g, '').includes(anchorText));
    if (!targetZone) throw new Error(`未找到包含 "${anchorText}" 的段落`);
  } else {
    targetZone = bodyZones.find((z) => !zoneText(z)) ?? bodyZones[0];
  }

  if (!zoneText(targetZone)) {
    await pasteHTML(targetZone, content);
    return {
      content,
      insertedBefore: hasBefore ? before : null,
      insertedAfter: hasAfter ? after : null,
      mode: 'direct',
    };
  }

  const leafSpans = targetZone.querySelectorAll('span[data-leaf="true"]');
  if (!leafSpans.length) throw new Error('目标段落结构异常');

  const firstText = leafSpans[0].firstChild;
  const lastText = leafSpans[leafSpans.length - 1].firstChild;
  targetZone.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  if (insertAfter) {
    if (lastText) {
      range.setStart(lastText, lastText.length);
    } else {
      range.selectNodeContents(targetZone);
      range.collapse(false);
    }
  } else if (firstText) {
    range.setStart(firstText, 0);
  } else {
    range.selectNodeContents(targetZone);
    range.collapse(true);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);

  document.dispatchEvent(new Event('selectionchange'));
  await new Promise((r) => setTimeout(r, 200));

  targetZone.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }),
  );

  await new Promise((r) => setTimeout(r, 300));

  const newZones = [...document.querySelectorAll('.page-block-children .zone-container.text-editor')];
  const targetIdx = newZones.indexOf(targetZone);
  const newZone = insertAfter ? newZones[targetIdx + 1] : newZones[targetIdx - 1];
  if (!newZone) throw new Error('插入新段落失败');

  await pasteHTML(newZone, content);

  return {
    content,
    insertedBefore: hasBefore ? before : null,
    insertedAfter: hasAfter ? after : null,
    mode: insertAfter ? 'after' : 'before',
  };
}
