// Popular agents aligned with AgentDeck and ACP Registry:
// https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
export const POPULAR_AGENTS = [
  {
    id: 'claude-acp',
    name: 'Claude Code',
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/claude-acp.svg',
  },
  {
    id: 'codex-acp',
    name: 'Codex',
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/codex-acp.svg',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/cursor.svg',
  },
  {
    id: 'pi-acp',
    name: 'pi',
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/gemini.svg',
  },
  {
    id: 'antigravity-acp',
    name: 'Google Antigravity',
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/antigravity-acp.svg',
  },
  {
    id: 'github-copilot-cli',
    name: 'GitHub Copilot',
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/opencode.svg',
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/qwen-code.svg',
  },
  {
    id: 'kimi',
    name: 'Kimi CLI',
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/kimi.svg',
  },
];

export function getAgentIconUrl(agentId) {
  const popular = POPULAR_AGENTS.find((agent) => agent.id === agentId);
  if (popular?.icon) return popular.icon;
  return `https://cdn.agentclientprotocol.com/registry/v1/latest/${agentId}.svg`;
}

export function getAgentName(agentId) {
  const popular = POPULAR_AGENTS.find((agent) => agent.id === agentId);
  return popular?.name || agentId;
}
