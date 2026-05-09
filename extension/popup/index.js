// biome-ignore-all lint/correctness/noUnusedPrivateClassMembers: gem decorators consume private fields
// biome-ignore-all lint/correctness/noUnusedVariables: gem @customElement consumes the class

import {
  adoptedStyle,
  connectStore,
  createState,
  css,
  customElement,
  GemElement,
  html,
  mounted,
  template,
} from '@mantou/gem';
import { initStore, isToolEnabled, mcpStore, setToolEnabled } from '../shared/mcp/store.js';

import 'duoyun-ui/elements/avatar';
import 'duoyun-ui/elements/loading';
import 'duoyun-ui/elements/switch';

function matchPattern(url, pattern) {
  if (!url || !pattern) return false;
  try {
    return new URLPattern(pattern).test(url);
  } catch {
    return false;
  }
}

const style = css({
  $: `
    display: flex;
    flex-direction: column;
    height: 100vh;
    box-sizing: border-box;
  `,
  top: `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid #e5e7eb;
  `,
  topTitle: `
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  `,
  gear: `
    width: 28px;
    height: 28px;
    border: 0;
    background: transparent;
    color: #6b7280;
    border-radius: 6px;
    cursor: pointer;
    font-size: 16px;
    &:hover { background: #f3f4f6; }
  `,
  tabInfo: `
    padding: 12px 14px 8px;
    border-bottom: 1px solid #e5e7eb;
  `,
  tabLine: `
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  `,
  tabLabel: `
    flex: none;
    font-size: 12px;
    color: #6b7280;
  `,
  tabUrl: `
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: #111827;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
    & span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  tabHint: `
    font-size: 11px;
    color: #9ca3af;
    margin-top: 4px;
  `,
  list: `
    flex: 1;
    overflow-y: auto;
    padding: 6px 8px;
  `,
  row: `
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 6px;
    border-radius: 8px;
    &:hover { background: #f3f4f6; }
  `,
  rowBody: `
    flex: 1;
    min-width: 0;
  `,
  rowName: `
    font-size: 13px;
    font-weight: 500;
    color: #111827;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  rowDesc: `
    font-size: 12px;
    color: #6b7280;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 2px;
  `,
  bottom: `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-top: 1px solid #e5e7eb;
    font-size: 12px;
  `,
  count: `
    color: #6b7280;
  `,
  linkBtn: `
    background: transparent;
    border: 0;
    color: #3b82f6;
    cursor: pointer;
    font: inherit;
    padding: 0;
  `,
  empty: `
    padding: 40px 20px;
    text-align: center;
    color: #6b7280;
    font-size: 13px;
  `,
});

@customElement('mcp-popup-page')
@adoptedStyle(style)
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
      <header class=${style.top}>
        <span class=${style.topTitle}>
          <dy-avatar>🧩</dy-avatar>
          MCP 工具
        </span>
        <button class=${style.gear} title="设置" aria-label="设置" @click=${this.#openOptions}>⚙</button>
      </header>

      <div class=${style.tabInfo}>
        <div class=${style.tabLine}>
          <div class=${style.tabLabel}>当前标签</div>
          <div class=${style.tabUrl} title=${url}>
            <span>🔗</span>
            <span>${url || '(无 URL)'}</span>
          </div>
        </div>
        <div class=${style.tabHint}>显示可在当前页面使用的工具</div>
      </div>

      <div class=${style.list}>
        ${
          matched.length === 0
            ? html`<div class=${style.empty}>当前页面没有匹配的工具</div>`
            : matched.map(
                ({ toolsetId, toolsetName, tool }) => html`
                  <div class=${style.row}>
                    <dy-avatar>${this.#initial(tool.name)}</dy-avatar>
                    <div class=${style.rowBody}>
                      <div class=${style.rowName} title=${`${tool.name} · ${toolsetName}`}>${tool.name}</div>
                      <div class=${style.rowDesc}>${toolsetName} · ${tool.description || '—'}</div>
                    </div>
                    <dy-switch
                      neutral="informative"
                      .checked=${isToolEnabled(toolsetId, tool.name)}
                      @change=${(e) => this.#toggleTool(toolsetId, tool.name, e)}
                    ></dy-switch>
                  </div>
                `,
              )
        }
      </div>

      <footer class=${style.bottom}>
        <span class=${style.count}>共 ${enabledCount} 个工具已启用</span>
        <button class=${style.linkBtn} @click=${this.#openOptions}>管理工具集</button>
      </footer>
    `;
  };
}
