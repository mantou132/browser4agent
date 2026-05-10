import { Modal } from 'duoyun-ui/elements/modal';
import { Toast } from 'duoyun-ui/elements/toast';
import { fnv1a } from 'duoyun-ui/lib/encode';
import { loadToolset } from '../shared/mcp/loader.js';
import { addToolset, initStore, mcpStore } from '../shared/mcp/store.js';

@customElement('mcp-options-page')
@connectStore(mcpStore)
class McpOptionsPageElement extends GemElement {
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
        <small class="text-describe">
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
        type: new URL(url).hostname.includes('extension') ? 'official' : 'community',
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
      <div class="block max-w-220 mx-auto pt-8 pb-16 px-7 box-border">
        <header class="flex items-center gap-3.5 mb-8">
          <dy-avatar size="large">🧩</dy-avatar>
          <div>
            <h1 class="text-[22px] m-0 text-highlight">MCP 扩展设置</h1>
            <p class="mt-1 text-describe text-[13px]">订阅和管理工具集</p>
          </div>
        </header>

        <section class="mt-7">
          <header class="flex items-end justify-between gap-3 mb-3.5">
            <div>
              <h2 class="m-0 text-[15px] text-highlight">工具集</h2>
              <p class="mt-1 text-describe text-xs">工具集是一个 JSON 文件，里面列出的工具字段类似 WebMCP，并额外包含 pattern 用来匹配页面。</p>
            </div>
            <dy-button @click=${this.#openAdd}>添加工具集</dy-button>
          </header>
          <div class="flex flex-col gap-2.5">
            ${
              toolsets.length
                ? toolsets.map((t) => html`<options-toolset-card .toolset=${t}></options-toolset-card>`)
                : html`<dy-empty text="暂未订阅任何工具集"></dy-empty>`
            }
            <button
              class="flex items-center justify-between py-3.5 px-4 border border-dashed border-border rounded-[10px] text-describe cursor-pointer bg-transparent w-full text-left font-inherit hover:border-primary hover:text-primary"
              @click=${() => Toast.open('default', '社区工具集市场即将推出')}
            >
              <span class="flex gap-2.5 items-center">
                <span class="text-lg">🧭</span>
                <span>
                  <strong>探索更多工具集</strong>
                  <div class="text-xs mt-0.5">访问社区工具集市场，发现更多工具</div>
                </span>
              </span>
              <span>›</span>
            </button>
          </div>
        </section>

        <section v-if=${!!recommended.length} class="mt-7">
          <header class="flex items-end justify-between gap-3 mb-3.5">
            <div>
              <h2 class="m-0 text-[15px] text-highlight">推荐工具集</h2>
              <p class="mt-1 text-describe text-xs">来自社区的精选工具集。</p>
            </div>
          </header>
          <div class="flex flex-col gap-2.5">
            ${recommended.map((t) => html`<options-toolset-card .toolset=${t}></options-toolset-card>`)}
          </div>
        </section>
      </div>
    `;
  };
}
