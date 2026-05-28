/**
 * Toolset 市场 Cloudflare Worker
 *
 * 单个 KV namespace `MARKET_KV`，key 是 toolset name，value 是下表 JSON：
 *
 *   字段          类型               说明
 *   ----------   ----------------   ------------------------------------------------
 *   name         string             主键，与 KV key 相同；PUT 不可改
 *   description  string
 *   icon         string             emoji 或 URL
 *   author       { name, email }    展示用，不参与鉴权，可任意修改
 *   tools        Tool[]             工具数组；列表接口返回 toolsCount 替代它
 *   installCount number             /install 自增，PUT 不覆盖
 *   likeCount    number             /like POST 自增、DELETE 自减（>=0）
 *   ownerHash    string             创建者 token 的 SHA-256 hex；服务端内部字段，
 *                                   响应里被剥掉；空值表示历史数据，首个带 token 的
 *                                   PUT/DELETE 会写入并锁定 owner
 *
 * 鉴权：写接口要求 `Authorization: Bearer <token>`，token 由扩展安装时生成并存到
 *   chrome.storage.sync。服务端只存 hash。
 */
import { parseToolsetJs, ValidationError } from 'toolset-parser';

const route = (method, pathname, handler) => ({ method, pattern: new URLPattern({ pathname }), handler });

const readToolset = async (env, name) => {
  const raw = await env.MARKET_KV.get(name, 'json');
  return (
    raw && {
      name: raw.name,
      description: raw.description || '',
      icon: raw.icon || '',
      author: { name: raw.author?.name || '', email: raw.author?.email || '' },
      tools: Array.isArray(raw.tools) ? raw.tools : [],
      installCount: Number(raw.installCount) || 0,
      likeCount: Number(raw.likeCount) || 0,
      ownerHash: raw.ownerHash || '',
    }
  );
};

const sanitizeInput = (input = {}) => ({
  name: typeof input.name === 'string' ? input.name : '',
  description: typeof input.description === 'string' ? input.description : '',
  icon: typeof input.icon === 'string' ? input.icon : '',
  author: { name: input.author?.name || '', email: input.author?.email || '' },
  tools: Array.isArray(input.tools) ? input.tools : [],
});

const serialize = ({ ownerHash: _ownerHash, ...rest } = {}) => rest;
const serializeSummary = (toolset) => {
  const { tools, ...rest } = serialize(toolset);
  return { ...rest, toolsCount: tools.length };
};

const sha256Hex = async (text) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
};

const auth = (handler) => async (req, env, params) => {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '');
  if (!match) return Response.json({ error: 'auth token required' }, { status: 401 });
  const hash = await sha256Hex(match[1].trim());
  return handler(hash, req, env, params);
};

const router = [
  route('GET', '/api/toolsets', async (_req, env) => {
    const { keys } = await env.MARKET_KV.list();
    const toolsets = [];
    for (const { name } of keys) {
      const t = await readToolset(env, name);
      if (t) toolsets.push(serializeSummary(t));
    }
    return Response.json(toolsets);
  }),

  route(
    'POST',
    '/api/toolsets',
    auth(async (hash, req, env) => {
      const input = sanitizeInput(await req.json());
      if (!input.name) return Response.json({ error: 'name is required' }, { status: 400 });
      if (await env.MARKET_KV.get(input.name)) {
        return Response.json({ error: 'toolset already exists' }, { status: 409 });
      }
      const stored = { ...input, installCount: 0, likeCount: 0, ownerHash: hash };
      await env.MARKET_KV.put(input.name, JSON.stringify(stored));
      return Response.json(serialize(stored), { status: 201 });
    }),
  ),

  route('POST', '/api/toolsets/parse', async (req) => {
    const { content, filename } = await req.json();
    if (typeof content !== 'string') return Response.json({ error: 'content is required' }, { status: 400 });
    try {
      return Response.json(parseToolsetJs(content, filename || 'toolset.ts'));
    } catch (err) {
      if (err instanceof ValidationError) return Response.json({ error: err.message }, { status: 400 });
      return Response.json({ error: 'Failed to parse content' }, { status: 400 });
    }
  }),

  route(
    'POST',
    '/api/toolsets/:encodeName/like',
    auth(async (_hash, _req, env, params) => {
      const name = decodeURIComponent(params.encodeName);
      const existing = await readToolset(env, name);
      if (!existing) return Response.json({ error: 'not found' }, { status: 404 });
      const stored = { ...existing, likeCount: existing.likeCount + 1 };
      await env.MARKET_KV.put(name, JSON.stringify(stored));
      return Response.json({ likeCount: stored.likeCount });
    }),
  ),

  route(
    'DELETE',
    '/api/toolsets/:encodeName/like',
    auth(async (_hash, _req, env, params) => {
      const name = decodeURIComponent(params.encodeName);
      const existing = await readToolset(env, name);
      if (!existing) return Response.json({ error: 'not found' }, { status: 404 });
      const stored = { ...existing, likeCount: Math.max(0, existing.likeCount - 1) };
      await env.MARKET_KV.put(name, JSON.stringify(stored));
      return Response.json({ likeCount: stored.likeCount });
    }),
  ),

  route('GET', '/api/toolsets/:encodeName', async (_req, env, params) => {
    const toolset = await readToolset(env, decodeURIComponent(params.encodeName));
    if (!toolset) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(serialize(toolset));
  }),

  route('POST', '/api/toolsets/:encodeName/install', async (_req, env, params) => {
    const name = decodeURIComponent(params.encodeName);
    const existing = await readToolset(env, name);
    if (!existing) return Response.json({ error: 'not found' }, { status: 404 });
    const stored = { ...existing, installCount: existing.installCount + 1 };
    await env.MARKET_KV.put(name, JSON.stringify(stored));
    return Response.json(serialize(stored));
  }),

  route(
    'PUT',
    '/api/toolsets/:encodeName',
    auth(async (hash, req, env, params) => {
      const name = decodeURIComponent(params.encodeName);
      const existing = await readToolset(env, name);
      if (!existing) return Response.json({ error: 'not found' }, { status: 404 });
      if (existing.ownerHash && existing.ownerHash !== hash) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      const input = sanitizeInput(await req.json());
      if (input.name !== existing.name) {
        return Response.json({ error: 'toolset name must match' }, { status: 400 });
      }
      const stored = {
        ...input,
        installCount: existing.installCount,
        likeCount: existing.likeCount,
        ownerHash: hash,
      };
      await env.MARKET_KV.put(name, JSON.stringify(stored));
      return Response.json(serialize(stored), { status: 201 });
    }),
  ),

  route(
    'DELETE',
    '/api/toolsets/:encodeName',
    auth(async (hash, _req, env, params) => {
      const name = decodeURIComponent(params.encodeName);
      const existing = await readToolset(env, name);
      if (!existing) return Response.json({ error: 'not found' }, { status: 404 });
      if (existing.ownerHash && existing.ownerHash !== hash) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      await env.MARKET_KV.delete(name);
      return Response.json({ deleted: true });
    }),
  ),
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const matches = router.map((r) => ({ route: r, result: r.pattern.exec(url.href) })).filter((m) => m.result);
    if (!matches.length) return Response.json({ error: 'not found' }, { status: 404 });
    const matched = matches.find((m) => m.route.method === request.method);
    if (!matched) return Response.json({ error: 'method not allowed' }, { status: 405 });
    return matched.route.handler(request, env, matched.result.pathname.groups);
  },
};
