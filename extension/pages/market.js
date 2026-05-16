import { initRequest } from '@mantou/gem/helper/request';
import { Modal } from 'duoyun-ui/elements/modal';
import { Toast } from 'duoyun-ui/elements/toast';
import { icons } from 'duoyun-ui/lib/icons';
import { createForm } from 'duoyun-ui/patterns/form';
import { loadToolset } from '../shared/loader.js';
import { addToolset, initStore, toolStore } from '../shared/store.js';
import { getToolsetId } from '../shared/toolsets.js';

const MARKET_API =
  import.meta.env.MODE === 'development'
    ? 'http://127.0.0.1:8787'
    : 'https://browser4agent-market.709922234.workers.dev';

const marketApi = initRequest({ origin: MARKET_API });

@customElement('agent-market-page')
@connectStore(toolStore)
class AgentMarketPageElement extends GemElement {
  #state = createState({
    toolsets: [],
    loading: true,
    error: '',
  });

  @mounted()
  #boot = async () => {
    initStore();
    this.#fetchToolsets();
  };

  #fetchToolsets = async () => {
    try {
      const data = await marketApi.get('/api/toolsets');
      this.#state({ toolsets: data, loading: false });
    } catch (e) {
      this.#state({ error: e instanceof Error ? e.message : String(e), loading: false });
    }
  };

  #getUrl = (name) => {
    return `${MARKET_API}/api/toolsets/${encodeURIComponent(name)}`;
  };

  #subscribe = async (t) => {
    const toolsetUrl = this.#getUrl(t.name);
    const id = getToolsetId(toolsetUrl);
    if (toolStore.toolsets.find((t) => t.id === id)) {
      return Toast.open('warning', '该工具集已订阅');
    }
    try {
      const { meta, tools } = await loadToolset(toolsetUrl);
      await addToolset({
        ...meta,
        id,
        url: toolsetUrl,
        type: 'community',
        enabled: true,
        tools,
      });
      Toast.open('success', `已添加：${meta.name}（${tools.length} 个工具）`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Toast.open('error', `加载失败：${msg}`);
    }
  };

  #publishToolset = async (defaults = {}) => {
    const editor = await Modal.open({
      header: '编辑工具',
      body: html`<market-tool-editor .initialTools=${defaults.tools}></market-tool-editor>`,
      okText: '下一步',
    });
    const tools = editor.getTools();

    const form = await createForm({
      type: 'modal',
      header: '发布工具集',
      data: defaults,
      formItems: [
        { label: '工具集名称', type: 'text', field: 'name', required: true, autofocus: true },
        { label: '描述', type: 'textarea', field: 'description', rows: 2 },
        { label: '图标', type: 'text', field: 'icon', placeholder: 'emoji' },
      ],
    });
    const meta = form.state.data;

    try {
      await marketApi.post('/api/toolsets', { ...meta, tools });
      Toast.open('success', '工具集已发布');
      this.#fetchToolsets();
    } catch (e) {
      Toast.open('error', `发布失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  #onDrop = async (evt, handle = this.#publishToolset) => {
    const file = evt.detail[0];
    if (!file) return;
    try {
      const content = await file.text();
      let toolset;
      if (file.name.endsWith('.json')) {
        const data = JSON.parse(content);
        toolset = Array.isArray(data) ? { tools: data } : data;
      } else {
        toolset = await marketApi.post('/api/toolsets/parse', { content, filename: file.name });
      }
      handle(toolset);
    } catch (e) {
      Toast.open('error', `解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  #onDropUpdate = (evt) => {
    this.#onDrop(evt, async (toolset) => {
      try {
        await marketApi.put(new URL(this.#getUrl(toolset.name)).pathname, toolset);
        Toast.open('success', '工具集已更新');
        this.#fetchToolsets();
      } catch (e) {
        Toast.open('error', `更新失败：${e instanceof Error ? e.message : String(e)}`);
      }
    });
  };

  #openOptions = () => {
    chrome.runtime.openOptionsPage();
  };

  @template()
  #content = () => {
    const { toolsets, loading, error } = this.#state;
    const subscribed = new Set(toolStore.toolsets.map((t) => t.id));
    const manifest = chrome.runtime.getManifest();
    const icon = chrome.runtime.getURL(manifest.icons['128']);

    return html`
      <div class="max-w-220 mx-auto pt-8 pb-16 px-7">
        <header class="flex items-center justify-between gap-3 mb-8">
          <dy-space size="large">
            <img src=${icon} class="w-12 h-12" />
            <h1 class="text-2xl m-0 text-highlight">工具集市场</h1>
          </dy-space>
          <div class="flex items-center gap-2">
            <dy-drop-area
              accept=".js,.ts,.json,application/json,text/javascript,text/typescript"
              @change=${this.#onDrop}
              tip=""
            >
              <dy-button .icon=${icons.add} @click=${this.#publishToolset}>发布工具集</dy-button>
            </dy-drop-area>
            <dy-button @click=${this.#openOptions}>返回设置</dy-button>
          </div>
        </header>

        <dy-divider></dy-divider>

        <section class="mt-7">
          <dy-loading v-if=${loading} class="py-20"></dy-loading>
          <dy-empty v-else-if=${!!error} class="py-20" text=${`加载失败：${error}`}></dy-empty>
          <dy-empty v-else-if=${!toolsets.length} class="py-20" text="暂无工具集"></dy-empty>
          <div v-else class="flex flex-col gap-5">
            ${toolsets.map(
              (t) => html`
                <dy-drop-area
                  accept=".js,.ts,.json,application/json,text/javascript,text/typescript"
                  @change=${this.#onDropUpdate}
                  class="flex items-center gap-3.5 py-3.5 px-4 border border-border rounded-xl"
                >
                  <dy-avatar size="large" square>${t.icon || '📦'}</dy-avatar>
                  <div class="flex-1 min-w-0">
                    <strong class="text-sm text-highlight">${t.name}</strong>
                    <div class="text-xs mt-1 text-describe">${t.description || ''}</div>
                    <div class="text-xs mt-1 text-describe">${t.toolsCount ?? '?'} 个工具</div>
                  </div>
                  <dy-button v-if=${!subscribed.has(getToolsetId(this.#getUrl(t.name)))} @click=${() => this.#subscribe(t)}>订阅</dy-button>
                  <span v-else class="text-xs text-describe">已订阅</span>
                </dy-drop-area>
              `,
            )}
          </div>
        </section>
      </div>
    `;
  };
}
