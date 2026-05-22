/**
 * @module Gmail Tools
 * @description 在 Gmail 网页版中打开写信界面并填写邮件草稿
 * @icon ✉️
 * @author Browser for AI Agent
 */

function queryFirst(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function setFieldValue(el, value) {
  if (!el || value == null) return false;
  el.focus?.();
  if ('value' in el) {
    el.value = String(value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value) }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el.isContentEditable) {
    el.textContent = String(value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value) }));
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasComposeForm() {
  return !!(
    queryFirst([
      'textarea[name="to"]',
      'input[name="to"]',
      '[aria-label*="To recipients"]',
      '[aria-label*="收件人"]',
    ]) ||
    queryFirst(['input[name="subjectbox"]', 'input[name="subject"]']) ||
    queryFirst([
      'div[aria-label*="Message Body"]',
      'div[aria-label*="邮件正文"]',
      '[role="textbox"][g_editable="true"]',
      'div[contenteditable="true"][g_editable="true"]',
    ])
  );
}

function openCompose() {
  if (location.hash.includes('compose')) {
    return { opened: true, alreadyOpen: true, method: 'existing' };
  }
  const composeBtn = queryFirst([
    'div[gh="cm"]',
    '[data-tooltip*="Compose"]',
    '[aria-label*="Compose"]',
    '[aria-label*="写邮件"]',
  ]);
  if (composeBtn) {
    composeBtn.click();
    return { opened: true, method: 'click' };
  }
  location.hash = 'inbox?compose=new';
  return { opened: true, method: 'hash' };
}

function fillCompose({ to = '', cc = '', subject = '', body = '' } = {}) {
  const filled = { to: false, cc: false, subject: false, body: false };
  if (to) {
    filled.to = setFieldValue(
      queryFirst([
        'textarea[name="to"]',
        'input[name="to"]',
        '[aria-label*="To recipients"]',
        '[aria-label*="收件人"]',
      ]),
      to,
    );
  }
  if (cc) {
    filled.cc = setFieldValue(
      queryFirst(['textarea[name="cc"]', 'input[name="cc"]', '[aria-label*="Cc"]', '[aria-label*="抄送"]']),
      cc,
    );
  }
  if (subject) {
    filled.subject = setFieldValue(queryFirst(['input[name="subjectbox"]', 'input[name="subject"]']), subject);
  }
  if (body) {
    filled.body = setFieldValue(
      queryFirst([
        'div[aria-label*="Message Body"]',
        'div[aria-label*="邮件正文"]',
        '[role="textbox"][g_editable="true"]',
        'div[contenteditable="true"][g_editable="true"]',
      ]),
      body,
    );
  }
  return filled;
}

/**
 * 打开 Gmail 写信界面并填写邮件草稿（收件人、抄送、主题、正文）
 * @pattern https://mail.google.com/*
 * @param {{ to?: string, cc?: string, subject?: string, body?: string }} options
 * @param {string} [options.to] - 收件人，多个地址用逗号分隔
 * @param {string} [options.cc] - 抄送
 * @param {string} [options.subject] - 邮件主题
 * @param {string} [options.body] - 邮件正文
 */
export async function write_email_draft({ to = '', cc = '', subject = '', body = '' } = {}) {
  const compose = openCompose();
  if (!compose.alreadyOpen) await sleep(300);

  for (let attempt = 0; attempt < 25; attempt++) {
    if (hasComposeForm()) {
      const filled = fillCompose({ to, cc, subject, body });
      if (!filled.to && !filled.cc && !filled.subject && !filled.body) {
        throw new Error('未找到可填写的写信字段');
      }
      return { compose, filled, url: location.href };
    }
    await sleep(150);
  }
  throw new Error('写信表单未加载，请稍后重试');
}
