/**
 * @module Feishu Docs Tools
 * @description 在飞书文档中修改标题、插入/删除段落（支持 Markdown）
 * @icon 📄
 * @author Browser for AI Agent
 */

async function pasteHTML(zone, md) {
  const rootEditor = document.querySelector('.page-block.root-block[contenteditable="true"]');
  if (!rootEditor) throw new Error('未找到编辑器根节点');

  const html = `<meta charset="utf-8">${window.__md2html(md)}`;
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

  await simulateInput(zone, '');
  return { deletedContent };
}

/**
 * 在指定段落前插入新内容（支持 Markdown 格式）
 * @pattern https://*.feishu.cn/*
 * @param {{ before: string, content: string }} options
 * @param {string} options.before - 目标段落的文本（模糊匹配），新内容将插入到该段落之前
 * @param {string} options.content - Markdown 格式的内容（支持标题/链接/加粗/代码块等）
 */
export async function insert_paragraph({ before, content } = {}) {
  if (!before) throw new Error('before is required');
  if (!content) throw new Error('content is required');

  const bodyZones = [...document.querySelectorAll('.page-block-children .zone-container.text-editor')];
  if (!bodyZones.length) throw new Error('未找到飞书文档正文区域');

  const targetZone = bodyZones.find((z) => z.textContent.replace(/\u200B/g, '').includes(before));
  if (!targetZone) throw new Error(`未找到包含 "${before}" 的段落`);

  const leafSpans = targetZone.querySelectorAll('span[data-leaf="true"]');
  if (!leafSpans.length) throw new Error('目标段落结构异常');

  const firstText = leafSpans[0].firstChild;
  targetZone.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(firstText, 0);
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
  const newZone = newZones[targetIdx - 1];
  if (!newZone) throw new Error('插入新段落失败');

  await pasteHTML(newZone, content);

  return { content, insertedBefore: before };
}
