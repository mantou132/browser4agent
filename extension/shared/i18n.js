const DEFAULT_LOCALE = 'zh-CN';

function normalizeSubstitutions(substitutions) {
  if (substitutions == null) return undefined;
  if (Array.isArray(substitutions)) return substitutions.map((value) => String(value));
  return String(substitutions);
}

export function getLocale() {
  const language = chrome.i18n.getUILanguage?.() || DEFAULT_LOCALE;
  return language.toLowerCase().startsWith('en') ? 'en' : DEFAULT_LOCALE;
}

/**
 * @param {keyof typeof import('../_locales/en/messages.json')} key
 */
export function t(key, substitutions) {
  return chrome.i18n.getMessage(key, normalizeSubstitutions(substitutions)) || key;
}

export function setPageI18n(titleKey) {
  if (!globalThis.document) return;
  document.documentElement.lang = getLocale();
  if (titleKey) document.title = t(titleKey);
}
