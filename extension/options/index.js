import { Toast } from 'duoyun-ui/elements/toast';
import { icons } from 'duoyun-ui/lib/icons';
import { theme } from 'duoyun-ui/lib/theme';
import { createForm } from 'duoyun-ui/patterns/form';
import { loadToolset } from '../shared/loader.js';
import { addToolset, initStore, toolStore } from '../shared/store.js';
import { openExtensionPage } from '../shared/tabs.js';
import { getToolsetId } from '../shared/toolsets.js';

const toolsets = require.context('../public/toolsets', false, /\.json$/);

const style = css`
  :scope {
    display: block;
    min-height: 100vh;
    background:
      radial-gradient(circle at 85% 12%, rgba(129, 140, 248, 0.2), transparent 32rem),
      radial-gradient(circle at 8% 88%, rgba(139, 92, 246, 0.12), transparent 28rem),
      linear-gradient(135deg, white 0%, #f8fafc 52%, #f5f3ff 100%);
  }
`;

@customElement('agent-options-page')
@connectStore(toolStore)
@adoptedStyle(style)
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
      style: { width: '30em' },
      header: '订阅工具集',
      formItems: [
        {
          label: '工具集 URL',
          type: 'text',
          field: 'url',
          placeholder: 'https://example.com/toolset.json 或 toolset.ts',
          autofocus: true,
          required: true,
        },
        {
          type: 'slot',
          slot: html`
            <small style=${styleMap({ color: theme.describeColor })}>
              支持 JSON、JavaScript、TypeScript 文件。JS/TS 中每个导出函数为一个工具，使用
              <code>@pattern</code> 等 JSDoc 标注元数据。
            </small>
          `,
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
    const { meta, tools } = await loadToolset(url);
    await addToolset({ ...meta, id, url, type: 'custom', enabled: true, tools });
    Toast.open('success', `已添加：${meta.name}（${tools.length} 个工具）`);
  };

  #openMarket = async () => {
    await openExtensionPage('pages/market.html');
  };

  @template()
  #content = () => {
    const { toolsets } = toolStore;
    const manifest = chrome.runtime.getManifest();
    const icon = chrome.runtime.getURL(manifest.icons['128']);
    return html`
      <main class="mx-auto flex w-full max-w-[64rem] flex-col gap-7 px-5 py-8 sm:px-7 sm:py-12">
        <header class="overflow-hidden rounded-lg border border-border bg-white/90 shadow-2xl shadow-slate-200/70 backdrop-blur">
          <div class="relative p-7 sm:flex sm:items-center sm:justify-between sm:gap-8 sm:p-8">
            <div class="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full bg-indigo-100/70 blur-3xl"></div>
            <div class="relative flex min-w-0 items-start gap-5">
              <img
                src=${icon}
                class="size-18 shrink-0 rounded-[1.125rem] shadow-xl shadow-indigo-500/20"
                alt="Browser for AI Agent"
              />
              <div class="min-w-0">
                <p class="m-0 text-sm font-semibold text-primary">Browser for AI Agent</p>
                <h1 class="m-0 mt-2 text-3xl font-bold leading-tight text-highlight">扩展设置</h1>
                <p class="mb-0 mt-3 max-w-2xl text-sm leading-6 text-describe sm:text-base">
                  管理 AI Agent 可调用的工具集，启用需要的能力，并从社区市场发现更多自动化方案。
                </p>
              </div>
            </div>
            <div class="relative mt-6 flex flex-wrap gap-3 sm:mt-0 sm:justify-end">
              <dy-button @click=${this.#openMarket}>打开市场</dy-button>
            </div>
          </div>
        </header>

        <section class="rounded-lg border border-border bg-white/90 p-5 shadow-xl shadow-slate-200/60 backdrop-blur sm:p-6">
          <header class="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 class="m-0 text-lg font-bold text-highlight">我的工具集</h2>
              <p class="mt-1 mb-0 text-describe text-xs">
                工具集可以是 JSON、JS 或 TS 文件；每个工具包含 name、description、execute、inputSchema、pattern 等字段
              </p>
            </div>
            <dy-button @click=${this.#openAdd}>订阅 URL</dy-button>
          </header>
          <div class="flex flex-col gap-5">
            ${
              toolsets.length
                ? toolsets.map((t) => html`<options-toolset-card .toolset=${t}></options-toolset-card>`)
                : html`<dy-empty class="py-20" text="暂未订阅任何工具集"></dy-empty>`
            }
          </div>
        </section>

        <section class="rounded-lg border border-border bg-white/90 p-5 shadow-xl shadow-slate-200/60 backdrop-blur sm:p-6">
          <header class="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 class="m-0 text-lg font-bold text-highlight">推荐工具集</h2>
              <p class="mt-1 mb-0 text-describe text-xs">从官方示例开始，也可以前往市场探索社区工具集。</p>
            </div>
          </header>
          <div class="flex flex-col gap-5">
            ${this.#recommended.map((t) => html`<options-toolset-card .recommended=${true} @subscription=${() => this.#addByUrl(t.url)} .toolset=${t}></options-toolset-card>`)}
            <div
              class="group flex cursor-pointer items-center gap-4 rounded-lg border border-dashed border-indigo-200 bg-indigo-50/60 p-5 text-describe transition hover:-translate-y-0.5 hover:border-primary hover:bg-indigo-50 hover:text-primary hover:shadow-lg hover:shadow-indigo-500/10"
              @click=${this.#openMarket}
            >
              <span class="grid size-14 shrink-0 place-items-center rounded-lg bg-white text-2xl shadow-sm">🧭</span>
              <div class="flex-1 min-w-0">
                <div class="mb-1 text-sm font-semibold text-highlight group-hover:text-primary">探索更多工具集</div>
                <div class="text-xs leading-5">访问社区工具集市场，发现更多网页自动化能力</div>
              </div>
              <dy-use .element=${icons.right}></dy-use>
            </div>
          </div>
        </section>
      </main>
    `;
  };
}
