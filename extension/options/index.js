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

import { Modal } from 'duoyun-ui/elements/modal';
import { Toast } from 'duoyun-ui/elements/toast';
import { fnv1a } from 'duoyun-ui/lib/encode';
import { loadToolset } from '../shared/mcp/loader.js';
import { addToolset, initStore, mcpStore } from '../shared/mcp/store.js';

import 'duoyun-ui/elements/avatar';
import 'duoyun-ui/elements/button';
import 'duoyun-ui/elements/empty';
import 'duoyun-ui/elements/form';
import './elements/toolset-card.js';

const style = css({
  $: `
    display: block;
    max-width: 880px;
    margin: 0 auto;
    padding: 32px 28px 64px;
    box-sizing: border-box;
  `,
  pageHeader: `
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 32px;
    & h1 { font-size: 22px; margin: 0; }
    & p { margin: 4px 0 0; color: #6b7280; font-size: 13px; }
  `,
  section: `
    margin-top: 28px;
  `,
  sectionHeader: `
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
    & h2 { margin: 0; font-size: 15px; }
    & p { margin: 4px 0 0; color: #6b7280; font-size: 12px; }
  `,
  stack: `
    display: flex;
    flex-direction: column;
    gap: 10px;
  `,
  more: `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border: 1px dashed #e5e7eb;
    border-radius: 10px;
    color: #6b7280;
    cursor: pointer;
    background: transparent;
    width: 100%;
    text-align: left;
    font: inherit;
    &:hover { border-color: #3b82f6; color: #3b82f6; }
  `,
  moreLeft: `
    display: flex;
    gap: 10px;
    align-items: center;
  `,
});

@customElement('mcp-options-page')
@adoptedStyle(style)
@connectStore(mcpStore)
class McpOptionsPageElement extends GemElement {
  // Recommended toolsets — endpoint not ready yet, kept as state for future fetch.
  #s = createState({ recommended: [] });

  @mounted()
  #boot = () => {
    initStore();
  };

  #openAdd = async () => {
    const form = await Modal.open({
      header: '添加工具集',
      body: html`
        <dy-form>
          <dy-form-item
            name="url"
            label="工具集 JSON URL"
            placeholder="https://example.com/toolset.json"
            autofocus
            @change=${(e) => {
              e.target.value = e.detail;
            }}
          ></dy-form-item>
        </dy-form>
        <small style="color:#6b7280">
          JSON 中的每个工具包含 <code>registerTool</code> 字段，并使用 <code>pattern</code>
          匹配页面。
        </small>
      `,
    });
    await this.#addByUrl(form.data.url.trim());
  };

  #addByUrl = async (url) => {
    if (!url) return;
    if (!URL.canParse(url)) {
      return Toast.open({ type: 'warning', content: '无效 URL' });
    }
    const id = String(fnv1a(url));
    if (mcpStore.toolsets.find((t) => t.id === id)) {
      return Toast.open({ type: 'warning', content: '该工具集已订阅' });
    }
    Toast.open({ key: 'add_toolset', type: 'default', content: `正在加载 ${url} ...` });
    try {
      const { meta, tools } = await loadToolset(url);
      await addToolset({
        id,
        url,
        name: meta.name,
        description: meta.description || '',
        icon: meta.icon || '',
        type: meta.type === 'official' ? 'official' : 'community',
        enabled: true,
        tools,
      });
      Toast.open({ key: 'add_toolset', type: 'success', content: `已添加：${meta.name}（${tools.length} 个工具）` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Toast.open({ key: 'add_toolset', type: 'error', content: `加载失败：${msg}` });
    }
  };

  @template()
  #content = () => {
    const { toolsets } = mcpStore;
    const { recommended } = this.#s;
    return html`
      <header class=${style.pageHeader}>
        <dy-avatar size="large">🧩</dy-avatar>
        <div>
          <h1>MCP 扩展设置</h1>
          <p>订阅和管理工具集</p>
        </div>
      </header>

      <section class=${style.section}>
        <header class=${style.sectionHeader}>
          <div>
            <h2>工具集</h2>
            <p>工具集是一个 JSON 文件，里面列出的工具字段类似 WebMCP，并额外包含 pattern 用来匹配页面。</p>
          </div>
          <dy-button @click=${this.#openAdd}>添加工具集</dy-button>
        </header>
        <div class=${style.stack}>
          ${
            toolsets.length
              ? toolsets.map((t) => html`<mcp-toolset-card .toolset=${t}></mcp-toolset-card>`)
              : html`<dy-empty text="暂未订阅任何工具集"></dy-empty>`
          }
          <button
            class=${style.more}
            @click=${() => Toast.open({ key: 'toolset_market', type: 'default', content: '社区工具集市场即将推出' })}
          >
            <span class=${style.moreLeft}>
              <span style="font-size:18px">🧭</span>
              <span>
                <strong>探索更多工具集</strong>
                <div style="font-size:12px;margin-top:2px">访问社区工具集市场，发现更多工具</div>
              </span>
            </span>
            <span>›</span>
          </button>
        </div>
      </section>

      <section v-if=${!!recommended.length} class=${style.section}>
        <header class=${style.sectionHeader}>
          <div>
            <h2>推荐工具集</h2>
            <p>来自社区的精选工具集。</p>
          </div>
        </header>
        <div class=${style.stack}>
          ${recommended.map((t) => html`<mcp-toolset-card .toolset=${t}></mcp-toolset-card>`)}
        </div>
      </section>
    `;
  };
}
