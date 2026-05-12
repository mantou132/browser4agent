const route = (method, pathname, handler) => ({ method, pattern: new URLPattern({ pathname }), handler });

const router = [
  route('GET', '/api/toolsets', async (_req, env, _params) => {
    const list = await env.MARKET_KV.list();
    const toolsets = [];
    for (const key of list.keys) {
      const value = await env.MARKET_KV.get(key.name, 'json');
      toolsets.push({ ...value, tools: undefined, toolsCount: value.tools?.length ?? 0 });
    }
    return Response.json(toolsets);
  }),

  route('POST', '/api/toolsets', async (req, env, _params) => {
    const body = await req.json();
    if (!body.name) return Response.json({ error: 'name is required' }, { status: 400 });
    const existing = await env.MARKET_KV.get(body.name, 'json');
    if (existing) return Response.json({ error: 'toolset already exists' }, { status: 409 });
    await env.MARKET_KV.put(body.name, JSON.stringify(body));
    return Response.json(body, { status: 201 });
  }),

  route('GET', '/api/toolsets/:encodeName', async (_req, env, params) => {
    const name = decodeURIComponent(params.encodeName);
    const value = await env.MARKET_KV.get(name, 'json');
    if (!value) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(value);
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
