import { Modal } from 'duoyun-ui/elements/modal';
import { Toast } from 'duoyun-ui/elements/toast';
import { icons } from 'duoyun-ui/lib/icons';
import { createForm } from 'duoyun-ui/patterns/form';
import { setPageI18n, t } from '../shared/i18n.js';
import { installToolset, loadToolset } from '../shared/loader.js';
import { MARKET_API, marketApi } from '../shared/market-api.js';
import { addToolset, initStore, toolStore } from '../shared/store.js';
import { openExtensionPage } from '../shared/tabs.js';
import { getToolsetId } from '../shared/toolsets.js';

setPageI18n('marketTitle');

const style = css`
  :scope {
    display: block;
    min-height: 100vh;
    background:
      radial-gradient(circle at 82% 10%, rgba(129, 140, 248, 0.2), transparent 32rem),
      radial-gradient(circle at 12% 92%, rgba(139, 92, 246, 0.13), transparent 28rem),
      linear-gradient(135deg, white 0%, #f8fafc 52%, #f5f3ff 100%);
  }
`;

@customElement('agent-market-page')
@connectStore(toolStore)
@adoptedStyle(style)
class AgentMarketPageElement extends GemElement {
  #state = createState({
    toolsets: [],
    loading: true,
    searchQuery: '',
  });

  @mounted()
  #boot = async () => {
    initStore();
    this.#fetchToolsets();
  };

  #fetchToolsets = async () => {
    try {
      const data = await marketApi.get('/api/toolsets');
      this.#state({ toolsets: data });
    } finally {
      this.#state({ loading: false });
    }
  };

  #getUrl = (name) => {
    return `${MARKET_API}/api/toolsets/${encodeURIComponent(name)}`;
  };

  #confirmAndInstall = async (toolset, { isUpdate }) => {
    const toolsetUrl = this.#getUrl(toolset.name);
    const id = getToolsetId(toolsetUrl);
    const preview = await loadToolset(toolsetUrl);
    await Modal.open({
      header: `${t(isUpdate ? 'updateToolset' : 'subscribeToolset')}: ${preview.meta.name || toolset.name}`,
      body: html`<market-tool-editor .initialTools=${preview.tools}></market-tool-editor>`,
      okText: t(isUpdate ? 'update' : 'subscribe'),
    });
    const { meta, tools } = await installToolset(toolsetUrl);
    await addToolset({ ...meta, id, url: toolsetUrl, type: 'community', enabled: true, tools });
    Toast.open('success', t(isUpdate ? 'toolsetUpdated' : 'addedToolset', [meta.name, tools.length]));
  };

  #publishToolset = async (defaults = {}) => {
    const data = { ...defaults, author: { ...defaults.author } };
    const editor = await Modal.open({
      header: t('editTool'),
      body: html`<market-tool-editor .initialTools=${data.tools}></market-tool-editor>`,
      okText: t('nextStep'),
    });
    const tools = editor.getTools();

    const form = await createForm({
      type: 'modal',
      header: t('publishToolset'),
      data,
      formItems: [
        { label: t('toolsetName'), type: 'text', field: 'name', required: true, autofocus: true },
        { label: t('description'), type: 'textarea', field: 'description', rows: 2 },
        { label: t('icon'), type: 'text', field: 'icon', placeholder: 'emoji' },
        { label: t('authorName'), type: 'text', field: ['author', 'name'] },
        { label: t('authorEmail'), type: 'text', field: ['author', 'email'] },
      ],
    });
    const meta = form.state.data;

    await marketApi.post('/api/toolsets', { ...meta, tools });
    Toast.open('success', t('toolsetPublished'));
    this.#fetchToolsets();
  };

  #onDrop = async (evt, handle = this.#publishToolset) => {
    const file = evt.detail[0];
    if (!file) return;
    const content = await file.text();
    let toolset;
    if (file.name.endsWith('.json')) {
      const data = JSON.parse(content);
      toolset = Array.isArray(data) ? { tools: data } : data;
    } else {
      toolset = await marketApi.post('/api/toolsets/parse', { content, filename: file.name });
    }
    handle(toolset);
  };

  #onDropUpdate = (evt, target) => {
    this.#onDrop(evt, async (toolset) => {
      await marketApi.put(new URL(this.#getUrl(target.name)).pathname, toolset);
      Toast.open('success', t('toolsetUpdated'));
      this.#fetchToolsets();
    });
  };

  #onSearch = (evt) => {
    this.#state({ searchQuery: evt.detail });
  };

  get #filteredToolsets() {
    const { toolsets, searchQuery } = this.#state;
    if (!searchQuery) return toolsets;
    const q = searchQuery.toLowerCase();
    return toolsets.filter(
      (t) =>
        t.name?.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        t.author?.name?.toLowerCase().includes(q),
    );
  }

  #openOptions = async () => {
    await openExtensionPage('options/index.html');
  };

  @template()
  #content = () => {
    const { toolsets, loading } = this.#state;
    const filtered = this.#filteredToolsets;
    const subscribed = new Set(toolStore.toolsets.map((t) => t.id));
    const manifest = chrome.runtime.getManifest();
    const icon = chrome.runtime.getURL(manifest.icons['128']);
    const totalTools = toolsets.reduce((count, t) => count + (t.toolsCount || 0), 0);
    const totalInstalls = toolsets.reduce((count, t) => count + (t.installCount || 0), 0);

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
                <p class="m-0 text-sm font-semibold text-primary">${t('marketEyebrow')}</p>
                <h1 class="m-0 mt-2 text-3xl font-bold leading-tight text-highlight">${t('marketTitle')}</h1>
                <p class="mb-0 mt-3 max-w-2xl text-sm leading-6 text-describe sm:text-base">
                  ${t('marketSubtitle')}
                </p>
              </div>
            </div>
            <div class="relative mt-6 flex flex-wrap gap-3 sm:mt-0 sm:justify-end">
              <dy-button @click=${this.#openOptions}>${t('backToSettings')}</dy-button>
            </div>
          </div>
          <div class="grid items-stretch gap-3 border-t border-border bg-slate-50/70 p-5 sm:grid-cols-3 sm:p-6">
            <market-stat-card label=${t('marketToolsets')} .value=${toolsets.length} description=${t('marketToolsetsDesc')} ?loading=${loading}></market-stat-card>
            <market-stat-card label=${t('coveredTools')} .value=${totalTools} description=${t('coveredToolsDesc')} ?loading=${loading}></market-stat-card>
            <market-stat-card label=${t('totalInstalls')} .value=${totalInstalls} description=${t('totalInstallsDesc')} ?loading=${loading}></market-stat-card>
          </div>
        </header>

        <section class="rounded-lg border border-border bg-white/90 p-5 shadow-xl shadow-slate-200/60 backdrop-blur sm:p-6">
          <header class="mb-5 flex flex-col gap-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <h2 class="m-0 text-lg font-bold text-highlight">${t('communityToolsets')}</h2>
                <p class="mb-0 mt-1 text-xs leading-5 text-describe">${t('communityToolsetsDesc')}</p>
              </div>
              <dy-drop-area
                accept=".js,.ts,.json,application/json,text/javascript,text/typescript"
                @change=${this.#onDrop}
                tip=""
              >
                <dy-tooltip .content=${t('publishToolsetTip')}>
                  <dy-button .icon=${icons.add} @click=${this.#publishToolset}>${t('publishToolset')}</dy-button>
                </dy-tooltip>
              </dy-drop-area>
            </div>
            <dy-input
              class="w-full"
              .icon=${icons.search}
              .value=${this.#state.searchQuery}
              @change=${this.#onSearch}
              placeholder=${t('searchToolsets')}
              clearable
              @clear=${this.#onSearch}
            ></dy-input>
          </header>
          <dy-loading v-if=${loading} class="py-20"></dy-loading>
          <dy-empty v-else-if=${!filtered.length} class="py-20" text=${this.#state.searchQuery ? t('noSearchResults') : t('emptyToolsets')}></dy-empty>
          <div v-else class="flex flex-col gap-5">
            ${filtered.map(
              (toolset) => html`
                <market-toolset-card
                  .toolset=${toolset}
                  url=${this.#getUrl(toolset.name)}
                  ?subscribed=${subscribed.has(getToolsetId(this.#getUrl(toolset.name)))}
                  @subscribe=${() => this.#confirmAndInstall(toolset, { isUpdate: false })}
                  @refresh=${() => this.#confirmAndInstall(toolset, { isUpdate: true })}
                  @change=${(evt) => this.#onDropUpdate(evt, toolset)}
                ></market-toolset-card>
              `,
            )}
          </div>
        </section>
      </main>
    `;
  };
}
