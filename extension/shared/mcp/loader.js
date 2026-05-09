function serializeTool(t) {
  if (!t || typeof t !== 'object') throw new Error('Invalid tool object');
  if (!t.name || typeof t.name !== 'string') throw new Error('Tool requires a string `name`');
  if (!t.execute || typeof t.execute !== 'string') throw new Error(`Tool ${t.name} requires a string execute`);
  return {
    name: t.name,
    execute: t.execute,
    description: typeof t.description === 'string' ? t.description : '',
    pattern: t.pattern || '',
    inputSchema:
      t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
  };
}

export async function loadToolset(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`工具集加载失败: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.tools)) throw new Error('工具集 JSON 缺少 tools 数组');
  const tools = data.tools.map(serializeTool);
  if (!tools.length) throw new Error('该工具集没有声明任何工具');
  if (!data.name) data.name = new URL(url).hostname;
  return { meta: data, tools };
}
