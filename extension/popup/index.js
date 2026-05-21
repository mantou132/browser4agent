import { icons } from 'duoyun-ui/lib/icons';
import { openExtensionPage } from '@/shared/tabs.js';
import { initStore, isToolEnabled, setToolEnabled, toolStore } from '../shared/store.js';

@customElement('agent-popup-page')
@connectStore(toolStore)
class AgentPopupPageElement extends GemElement {
  #s = createState({ tab: null, ready: false });
  #initial = (name) => ((name || '').trim()[0] || '?').toUpperCase();

  @mounted()
  #boot = async () => {
    await initStore();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    this.#s({ tab: tab, ready: true });
  };

  #openOptions = () => {
    openExtensionPage('options/index.html');
    window.close();
  };

  #toggleTool = (toolsetId, toolName, e) => {
    setToolEnabled(toolsetId, toolName, e.detail);
  };

  #matched() {
    const url = this.#s.tab?.url || '';
    const out = [];
    for (const ts of toolStore.toolsets) {
      if (!ts.enabled) continue;
      for (const tool of ts.tools || []) {
        if (new URLPattern(tool.pattern).test(url)) {
          out.push({ toolsetId: ts.id, toolsetName: ts.name, tool });
        }
      }
    }
    return out;
  }

  @template()
  #content = () => {
    if (!this.#s.ready) return html`<dy-loading></dy-loading>`;

    const manifest = chrome.runtime.getManifest();
    const icon = chrome.runtime.getURL(manifest.icons['128']);
    const matched = this.#matched();
    const enabledCount = matched.filter((m) => isToolEnabled(m.toolsetId, m.tool.name)).length;
    const url = this.#s.tab?.url || '';

    return html`
      <div class="flex flex-col h-screen box-border">
        <header class="flex items-center justify-between py-3 px-3.5 border-b border-border">
          <span class="flex items-center gap-2 font-semibold text-highlight">
            <img src=${icon} class="w-6 h-6" />
            <span>${manifest.name}</span>
          </span>
          <dy-button .icon=${icons.tune} square color="cancel" @click=${this.#openOptions}></dy-button>
        </header>

        <div class="pt-3 pb-2 px-3.5 border-b border-border">
          <div class="flex items-center gap-2 min-w-0">
            <div class="shrink-0 text-xs text-describe">当前标签</div>
            <div class="flex-1 min-w-0 text-xs text-highlight flex items-center gap-1.5 truncate" title=${url}>
              <span>🔗</span>
              <span class="truncate">${url || '(无 URL)'}</span>
            </div>
          </div>
          <div class="text-xs text-neutral mt-1">下面显示的是 AI Agent 可在当前页面使用的工具</div>
        </div>

        <div class="flex-1 overflow-y-auto py-1.5 px-2">
          ${
            matched.length === 0
              ? html`<div class="py-10 px-5 text-center text-describe text-sm">没有匹配的工具</div>`
              : matched.map(
                  ({ toolsetId, toolsetName, tool }) => html`
                    <div class="flex items-center gap-2.5 py-2 px-1.5 rounded-sm hover:bg-bg-hover">
                      <dy-avatar square>${this.#initial(tool.name)}</dy-avatar>
                      <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium text-highlight truncate" title=${`${tool.name} · ${toolsetName}`}>${tool.name}</div>
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
          <dy-action-text class="text-primary" @click=${this.#openOptions}>管理工具集</dy-action-text>
        </footer>
      </div>
    `;
  };
}
