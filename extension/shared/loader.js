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
  };
}

export async function loadToolset(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`工具集加载失败: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.tools) || !data.tools.length) throw new Error('该工具集没有声明任何工具');
  if (!data.name) data.name = new URL(url).hostname;
  return { meta: serializeToolset(data), tools: data.tools.map(serializeTool) };
}
