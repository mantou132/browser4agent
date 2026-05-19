import { parseToolsetJs, ValidationError } from 'toolset-parser';

const route = (method, pathname, handler) => ({ method, pattern: new URLPattern({ pathname }), handler });

const normalizeToolset = (toolset) =>
  toolset && {
    ...toolset,
    installCount: Number(toolset.installCount) || 0,
    author: {
      name: toolset.author?.name || '',
      email: toolset.author?.email || '',
    },
  };

const serializeToolsetSummary = (toolset) => ({
  ...toolset,
  tools: undefined,
  toolsCount: toolset.tools?.length ?? 0,
  installCount: toolset.installCount ?? 0,
});

const isSameAuthor = (a, b) => a.name === b.name && a.email === b.email;

const router = [
  route('GET', '/api/toolsets', async (_req, env, _params) => {
    const list = await env.MARKET_KV.list();
    const toolsets = [];
    for (const key of list.keys) {
      const value = await env.MARKET_KV.get(key.name, 'json');
      toolsets.push(serializeToolsetSummary(normalizeToolset(value)));
    }
    return Response.json(toolsets);
  }),

  route('POST', '/api/toolsets', async (req, env, _params) => {
    const toolset = normalizeToolset(await req.json());
    if (!toolset.name) return Response.json({ error: 'name is required' }, { status: 400 });
    const existing = await env.MARKET_KV.get(toolset.name, 'json');
    if (existing) return Response.json({ error: 'toolset already exists' }, { status: 409 });
    await env.MARKET_KV.put(toolset.name, JSON.stringify(toolset));
    return Response.json(toolset, { status: 201 });
  }),

  route('POST', '/api/toolsets/parse', async (req, _env, _params) => {
    const { content, filename } = await req.json();
    if (typeof content !== 'string') return Response.json({ error: 'content is required' }, { status: 400 });
    try {
      const toolset = parseToolsetJs(content, filename || 'toolset.ts');
      return Response.json(toolset);
    } catch (err) {
      if (err instanceof ValidationError) return Response.json({ error: err.message }, { status: 400 });
      return Response.json({ error: 'Failed to parse content' }, { status: 400 });
    }
  }),

  route('GET', '/api/toolsets/:encodeName', async (_req, env, params) => {
    const name = decodeURIComponent(params.encodeName);
    const toolset = normalizeToolset(await env.MARKET_KV.get(name, 'json'));
    if (!toolset) return Response.json({ error: 'not found' }, { status: 404 });
    const installed = { ...toolset, installCount: toolset.installCount + 1 };
    await env.MARKET_KV.put(name, JSON.stringify(installed));
    return Response.json(installed);
  }),

  route('PUT', '/api/toolsets/:encodeName', async (req, env, params) => {
    const name = decodeURIComponent(params.encodeName);
    const existing = normalizeToolset(await env.MARKET_KV.get(name, 'json'));
    if (!existing) return Response.json({ error: 'not found' }, { status: 404 });
    const update = normalizeToolset(await req.json());
    if (update.name !== existing.name) return Response.json({ error: 'toolset name must match' }, { status: 400 });
    if (!isSameAuthor(update.author, existing.author)) {
      return Response.json({ error: 'toolset author must match' }, { status: 400 });
    }
    const toolset = normalizeToolset({ ...existing, ...update, installCount: existing.installCount });
    await env.MARKET_KV.put(name, JSON.stringify(toolset));
    return Response.json(toolset, { status: 201 });
  }),

  route('DELETE', '/api/toolsets/:encodeName', async (_req, env, params) => {
    const name = decodeURIComponent(params.encodeName);
    await env.MARKET_KV.delete(name);
    return Response.json({ deleted: true });
  }),
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
