import { t } from './i18n.js';
import { marketApi } from './market-api.js';

function serializeTool(t) {
  if (!t || typeof t !== 'object') throw new Error('Invalid tool object');
  if (!t.name || typeof t.name !== 'string') throw new Error('Tool requires a string `name`');
  if (!t.pattern || typeof t.pattern !== 'string') throw new Error('Tool requires a string `pattern`');
  if (!t.execute || typeof t.execute !== 'string') throw new Error(`Tool ${t.name} requires a string execute`);
  return {
    name: t.name,
    execute: t.execute,
    pattern: t.pattern,
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema:
      t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
  };
}

function serializeToolset(data) {
  return {
    name: typeof data.name === 'string' ? data.name : '',
    description: typeof data.description === 'string' ? data.description : '',
    icon: typeof data.icon === 'string' ? data.icon : '',
    author:
      data.author && typeof data.author === 'object'
        ? {
            name: typeof data.author.name === 'string' ? data.author.name : '',
            email: typeof data.author.email === 'string' ? data.author.email : '',
          }
        : undefined,
  };
}

function isJsTsUrl(url) {
  return /\.(?:[cm]?[jt]s)$/i.test(new URL(url).pathname);
}

function isJsTsContentType(contentType) {
  return /javascript|typescript/i.test(contentType);
}

async function parseToolsetContent(content) {
  return marketApi.post('/api/toolsets/parse', { content, filename: 'toolset.ts' });
}

function parseToolsetData(data, fallbackUrl) {
  if (!Array.isArray(data.tools) || !data.tools.length) throw new Error(t('toolsetNoTools'));
  if (!data.name) data.name = new URL(fallbackUrl).hostname;
  return { meta: serializeToolset(data), tools: data.tools.map(serializeTool) };
}

export async function loadToolset(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(t('toolsetLoadFailed', res.status));

  const contentType = res.headers.get('content-type') || '';
  const useParser = isJsTsUrl(url) || isJsTsContentType(contentType);
  const data = useParser ? await parseToolsetContent(await res.text()) : await res.json();

  return parseToolsetData(data, url);
}

export async function installToolset(url) {
  const res = await fetch(`${url.replace(/\/$/, '')}/install`, { method: 'POST', credentials: 'omit' });
  if (!res.ok) throw new Error(t('toolsetLoadFailed', res.status));
  return parseToolsetData(await res.json(), url);
}
