import { initStore, isToolEnabled, mcpStore, setToolEnabled } from '../shared/mcp/store.js';

function matchPattern(url, pattern) {
  if (!url || !pattern) return false;
  try {
    return new URLPattern(pattern).test(url);
  } catch {
    return false;
  }
}

@customElement('mcp-popup-page')
@connectStore(mcpStore)
class McpPopupPageElement extends GemElement {
  #s = createState({ tab: null, ready: false });
  #initial = (name) => ((name || '').trim()[0] || '?').toUpperCase();

  @mounted()
  #boot = async () => {
    await initStore();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    this.#s({ tab: tab, ready: true });
  };

  #openOptions = () => {
    chrome.runtime.openOptionsPage();
    window.close();
  };

  #toggleTool = (toolsetId, toolName, e) => {
    setToolEnabled(toolsetId, toolName, e.detail);
  };

  #matched() {
    const url = this.#s.tab?.url || '';
    const out = [];
    for (const ts of mcpStore.toolsets) {
      if (!ts.enabled) continue;
      for (const tool of ts.tools || []) {
        if (matchPattern(url, tool.pattern)) {
          out.push({ toolsetId: ts.id, toolsetName: ts.name, tool });
        }
      }
    }
    return out;
  }

  @template()
  #content = () => {
    if (!this.#s.ready) return html`<dy-loading></dy-loading>`;

    const matched = this.#matched();
    const enabledCount = matched.filter((m) => isToolEnabled(m.toolsetId, m.tool.name)).length;
    const url = this.#s.tab?.url || '';

    return html`
      <div class="flex flex-col h-screen box-border">
        <header class="flex items-center justify-between py-3 px-3.5 border-b border-border">
          <span class="flex items-center gap-2 font-semibold text-highlight">
            <dy-avatar>🧩</dy-avatar>
            MCP 工具
          </span>
          <button class="w-7 h-7 border-0 bg-transparent text-describe rounded-normal cursor-pointer text-base hover:bg-bg-hover" title="设置" aria-label="设置" @click=${this.#openOptions}>⚙</button>
        </header>

        <div class="pt-3 pb-2 px-3.5 border-b border-border">
          <div class="flex items-center gap-2 min-w-0">
            <div class="shrink-0 text-xs text-describe">当前标签</div>
            <div class="flex-1 min-w-0 text-xs text-highlight flex items-center gap-1.5 truncate" title=${url}>
              <span>🔗</span>
              <span class="truncate">${url || '(无 URL)'}</span>
            </div>
          </div>
          <div class="text-[11px] text-neutral mt-1">显示可在当前页面使用的工具</div>
        </div>

        <div class="flex-1 overflow-y-auto py-1.5 px-2">
          ${
            matched.length === 0
              ? html`<div class="py-10 px-5 text-center text-describe text-[13px]">当前页面没有匹配的工具</div>`
              : matched.map(
                  ({ toolsetId, toolsetName, tool }) => html`
                    <div class="flex items-center gap-2.5 py-2 px-1.5 rounded-normal hover:bg-bg-hover">
                      <dy-avatar>${this.#initial(tool.name)}</dy-avatar>
                      <div class="flex-1 min-w-0">
                        <div class="text-[13px] font-medium text-highlight truncate" title=${`${tool.name} · ${toolsetName}`}>${tool.name}</div>
                        <div class="text-xs text-describe truncate mt-0.5">${toolsetName} · ${tool.description || '—'}</div>
                      </div>
                      <dy-switch
                        neutral="positive"
                        .checked=${isToolEnabled(toolsetId, tool.name)}
                        @change=${(e) => this.#toggleTool(toolsetId, tool.name, e)}
                      ></dy-switch>
                    </div>
                  `,
                )
          }
        </div>

        <footer class="flex items-center justify-between py-2.5 px-3.5 border-t border-border text-xs">
          <span class="text-describe">共 ${enabledCount} 个工具已启用</span>
          <button class="bg-transparent border-0 text-primary cursor-pointer font-inherit p-0" @click=${this.#openOptions}>管理工具集</button>
        </footer>
      </div>
    `;
  };
}
