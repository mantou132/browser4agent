import { Toast } from 'duoyun-ui/elements/toast';
import { icons } from 'duoyun-ui/lib/icons';
import { createForm } from 'duoyun-ui/patterns/form';
import { loadToolset } from '../shared/mcp/loader.js';
import { addToolset, initStore, mcpStore } from '../shared/mcp/store.js';
import { getToolsetId } from '../shared/mcp/toolsets.js';

const toolsets = require.context('../toolsets', false, /\.json$/);

@customElement('mcp-options-page')
@connectStore(mcpStore)
class McpOptionsPageElement extends GemElement {
  #state = createState({
    recommended: toolsets.keys().map((key) => {
      return {
        ...toolsets(key),
        type: 'official',
        // 确保 url 固定，id 从 url 生成
        url: chrome.runtime.getURL(`toolsets/${key}`),
      };
    }),
  });

  @memo(() => [mcpStore.toolsets])
  get #recommended() {
    const subscribed = new Set(mcpStore.toolsets.map((t) => t.id));
    return this.#state.recommended.filter((t) => !subscribed.has(getToolsetId(t.url)));
  }

  @mounted()
  #boot = () => {
    initStore();
  };

  #openAdd = async () => {
    const form = await createForm({
      type: 'modal',
      header: '添加工具集',
      formItems: [
        {
          label: '工具集 JSON URL',
          type: 'text',
          field: 'url',
          placeholder: 'https://example.com/toolset.json',
          autofocus: true,
          required: true,
        },
        {
          type: 'slot',
          slot: html`<small class="text-describe">
            JSON 中的每个工具包含 <code>registerTool</code> 字段，并使用 <code>pattern</code>
            匹配页面。
          </small>`,
        },
      ],
    });
    await this.#addByUrl(form.state.data.url.trim());
  };

  #addByUrl = async (url) => {
    if (!url) return;
    if (!URL.canParse(url)) {
      return Toast.open('warning', '无效 URL');
    }
    const id = getToolsetId(url);
    if (mcpStore.toolsets.find((t) => t.id === id)) {
      return Toast.open('warning', '该工具集已订阅');
    }
    try {
      const { meta, tools } = await loadToolset(url);
      await addToolset({
        id,
        url,
        name: meta.name,
        description: meta.description || '',
        icon: meta.icon || '',
        type: new URL(url).protocol === 'blob' ? 'official' : 'community',
        enabled: true,
        tools,
      });
      Toast.open('success', `已添加：${meta.name}（${tools.length} 个工具）`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Toast.open('error', `加载失败：${msg}`);
    }
  };

  @template()
  #content = () => {
    const { toolsets } = mcpStore;
    const manifest = chrome.runtime.getManifest();
    const icon = chrome.runtime.getURL(manifest.icons['128']);
    return html`
      <div class="max-w-220 mx-auto pt-8 pb-16 px-7">
        <header class="gap-3.5 mb-8">
          <dy-space size="large">
            <img src=${icon} class="w-12 h-12" />
            <h1 class="text-2xl m-0 text-highlight">扩展设置</h1>
          </dy-space>
          <p class="mt-1 mb-0 text-describe text-sm">订阅、管理和发现工具集</p>
        </header>

        <dy-divider></dy-divider>

        <section class="mt-7">
          <header class="flex items-center justify-between gap-3 mb-5">
            <div>
              <h2 class="m-0 text-base text-highlight">工具集</h2>
              <p class="mt-1 mb-0 text-describe text-xs">
                工具集是一个 JSON 文件，里面的每个工具包含 name、description、execute、inputSchema、pattern 等字段
              </p>
            </div>
            <dy-button @click=${this.#openAdd}>添加工具集</dy-button>
          </header>
          <div class="flex flex-col gap-5">
            ${
              toolsets.length
                ? toolsets.map((t) => html`<options-toolset-card .toolset=${t}></options-toolset-card>`)
                : html`<dy-empty class="py-20" text="暂未订阅任何工具集"></dy-empty>`
            }
            <button
              class="flex items-center gap-3.5 py-3.5 px-4 border border-dashed border-border rounded-xl text-describe cursor-pointer bg-transparent w-full text-left font-inherit hover:border-primary hover:text-primary"
              @click=${() => Toast.open('default', '社区工具集市场即将推出')}
            >
              <dy-avatar size="large" class="bg-neutral/10">🧭</dy-avatar>
              <div class="flex-1 min-w-0">
                <strong class="text-sm">探索更多工具集</strong>
                <div class="text-xs mt-1">访问社区工具集市场，发现更多工具</div>
              </div>
              <dy-use .element=${icons.right}></dy-use>
            </button>
          </div>
        </section>

        <section v-if=${!!this.#recommended.length} class="mt-7">
          <header class="flex items-center justify-between gap-3 mb-5">
            <div>
              <h2 class="m-0 text-base text-highlight">推荐工具集</h2>
              <p class="mt-1 text-describe text-xs">来自社区的精选工具集。</p>
            </div>
          </header>
          <div class="flex flex-col gap-5">
            ${this.#recommended.map((t) => html`<options-toolset-card .recommended=${true} @subscription=${() => this.#addByUrl(t.url)} .toolset=${t}></options-toolset-card>`)}
          </div>
        </section>
      </div>
    `;
  };
}
