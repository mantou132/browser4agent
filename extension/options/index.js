import { Toast } from 'duoyun-ui/elements/toast';
import { icons } from 'duoyun-ui/lib/icons';
import { createForm } from 'duoyun-ui/patterns/form';
import { loadToolset } from '../shared/loader.js';
import { addToolset, initStore, toolStore } from '../shared/store.js';
import { getToolsetId } from '../shared/toolsets.js';

const toolsets = require.context('../public/toolsets', false, /\.json$/);

@customElement('agent-options-page')
@connectStore(toolStore)
class AgentOptionsPageElement extends GemElement {
  #state = createState({
    recommended: toolsets.keys().map((key) => {
      return {
        ...toolsets(key),
        type: 'official',
        url: new URL(`toolsets/${key}`, location.origin).href,
      };
    }),
  });

  @memo(() => [toolStore.toolsets])
  get #recommended() {
    const subscribed = new Set(toolStore.toolsets.map((t) => t.id));
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
    await this.#addByUrl(form.state.data.url?.trim());
  };

  #addByUrl = async (url) => {
    if (!url) return;
    if (!URL.canParse(url)) {
      return Toast.open('warning', '无效 URL');
    }
    const id = getToolsetId(url);
    if (toolStore.toolsets.find((t) => t.id === id)) {
      return Toast.open('warning', '该工具集已订阅');
    }
    try {
      const { meta, tools } = await loadToolset(url);
      await addToolset({
        ...meta,
        id,
        url,
        type: new URL(url).protocol.includes('extension') ? 'official' : 'community',
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
    const { toolsets } = toolStore;
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
          </div>
        </section>

        <section class="mt-7">
          <header class="flex items-center justify-between gap-3 mb-5">
            <div>
              <h2 class="m-0 text-base text-highlight">推荐工具集</h2>
              <p class="mt-1 text-describe text-xs">来自社区的精选工具集。</p>
            </div>
          </header>
          <div class="flex flex-col gap-5">
            ${this.#recommended.map((t) => html`<options-toolset-card .recommended=${true} @subscription=${() => this.#addByUrl(t.url)} .toolset=${t}></options-toolset-card>`)}
            <div
              class="flex items-center gap-3.5 py-3.5 px-4 border border-dashed border-border rounded-xl text-describe cursor-pointer hover:border-primary hover:text-primary"
              @click=${() => chrome.tabs.create({ url: chrome.runtime.getURL('pages/market.html') })}
            >
              <dy-avatar size="large" square>🧭</dy-avatar>
              <div class="flex-1 min-w-0">
                <div class="text-sm mb-2">探索更多工具集</div>
                <div class="text-xs">访问社区工具集市场，发现更多工具</div>
              </div>
              <dy-use .element=${icons.right}></dy-use>
            </div>
          </div>
        </section>
      </div>
    `;
  };
}
