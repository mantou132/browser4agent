import { repeat } from '@mantou/gem';
import { Toast } from 'duoyun-ui/elements/toast';
import { icons } from 'duoyun-ui/lib/icons';
import { theme } from 'duoyun-ui/lib/theme';
import { createForm } from 'duoyun-ui/patterns/form';
import { visible } from '@/shared/decorators.js';
import { setPageI18n, t } from '../shared/i18n.js';
import { loadToolset } from '../shared/loader.js';
import { addToolset, initStore, toolStore } from '../shared/store.js';
import { openExtensionPage } from '../shared/tabs.js';
import { getToolsetId } from '../shared/toolsets.js';

const toolsets = require.context('../public/toolsets', false, /\.json$/);

setPageI18n('optionsTitle');

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
  @visible()
  #boot = () => {
    initStore();
  };

  #openAdd = async () => {
    const form = await createForm({
      type: 'modal',
      style: { width: '30em' },
      header: t('subscribeToolset'),
      formItems: [
        {
          label: t('toolsetUrlLabel'),
          type: 'text',
          field: 'url',
          placeholder: t('toolsetUrlPlaceholder'),
          autofocus: true,
          required: true,
        },
        {
          type: 'slot',
          slot: html`
            <small style=${styleMap({ color: theme.describeColor })}>
              ${t('toolsetUrlHelpBeforePattern')}
              <code>@pattern</code>
              ${t('toolsetUrlHelpAfterPattern')}
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
      return Toast.open('warning', t('invalidUrl'));
    }
    const id = getToolsetId(url);
    if (toolStore.toolsets.find((t) => t.id === id)) {
      return Toast.open('warning', t('toolsetAlreadySubscribed'));
    }
    const { meta, tools } = await loadToolset(url);
    const recommended = this.#state.recommended.find((t) => t.url === url);
    await addToolset({ ...meta, id, url, type: recommended ? 'official' : 'custom', enabled: true, tools });
    Toast.open('success', t('addedToolset', [meta.name, tools.length]));
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
                <h1 class="m-0 mt-2 text-3xl font-bold leading-tight text-highlight">${t('optionsTitle')}</h1>
                <p class="mb-0 mt-3 max-w-2xl text-sm leading-6 text-describe sm:text-base">
                  ${t('optionsSubtitle')}
                </p>
              </div>
            </div>
            <div class="relative mt-6 flex flex-wrap gap-3 sm:mt-0 sm:justify-end">
              <dy-button @click=${this.#openMarket}>${t('openMarket')}</dy-button>
            </div>
          </div>
        </header>

        <section class="rounded-lg border border-border bg-white/90 p-5 shadow-xl shadow-slate-200/60 backdrop-blur sm:p-6">
          <header class="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 class="m-0 text-lg font-bold text-highlight">${t('myToolsets')}</h2>
              <p class="mt-1 mb-0 text-describe text-xs">
                ${t('myToolsetsDesc')}
              </p>
            </div>
            <dy-button @click=${this.#openAdd}>${t('subscribeUrl')}</dy-button>
          </header>
          <div class="flex flex-col gap-5">
            ${
              toolsets.length
                ? repeat(
                    toolsets,
                    (t) => t.id,
                    (t) => html`<options-toolset-card .toolset=${t}></options-toolset-card>`,
                  )
                : html`<dy-empty class="py-20" text=${t('emptySubscribedToolsets')}></dy-empty>`
            }
          </div>
        </section>

        <section class="rounded-lg border border-border bg-white/90 p-5 shadow-xl shadow-slate-200/60 backdrop-blur sm:p-6">
          <header class="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 class="m-0 text-lg font-bold text-highlight">${t('recommendedToolsets')}</h2>
              <p class="mt-1 mb-0 text-describe text-xs">${t('recommendedDesc')}</p>
            </div>
          </header>
          <div class="flex flex-col gap-5">
            ${repeat(
              this.#recommended,
              (t) => t.url,
              (t) =>
                html`<options-toolset-card .recommended=${true} @subscription=${() => this.#addByUrl(t.url)} .toolset=${t}></options-toolset-card>`,
            )}
            <div
              class="group flex cursor-pointer items-center gap-4 rounded-lg border border-dashed border-indigo-200 bg-indigo-50/60 p-5 text-describe transition hover:-translate-y-0.5 hover:border-primary hover:bg-indigo-50 hover:text-primary hover:shadow-lg hover:shadow-indigo-500/10"
              @click=${this.#openMarket}
            >
              <span class="grid size-14 shrink-0 place-items-center rounded-lg bg-white text-2xl shadow-sm">🧭</span>
              <div class="flex-1 min-w-0">
                <div class="mb-1 text-sm font-semibold text-highlight group-hover:text-primary">${t('exploreMoreToolsets')}</div>
                <div class="text-xs leading-5">${t('exploreMoreToolsetsDesc')}</div>
              </div>
              <dy-use .element=${icons.right}></dy-use>
            </div>
          </div>
        </section>
      </main>
    `;
  };
}
