import { repeat } from '@mantou/gem';
import { Toast } from 'duoyun-ui/elements/toast';
import { icons } from 'duoyun-ui/lib/icons';
import { theme } from 'duoyun-ui/lib/theme';
import { createForm } from 'duoyun-ui/patterns/form';
import { setPageI18n, t } from '../shared/i18n.js';
import { loadToolset } from '../shared/loader.js';
import { openExtensionPage } from '../shared/tabs.js';
import { addToolset, initStore, toolStore } from '../shared/tool-store.js';
import { getToolsetId } from '../shared/toolsets.js';

const toolsets = require.context('../public/toolsets', false, /\.json$/);

setPageI18n('optionsTitle');

const style = css`
  :scope {
    display: block;
    min-height: 100vh;
    background: #f8fafc;
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
  get _recommended() {
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
      <header class="sticky top-0 z-10 border-b border-border bg-white/90 backdrop-blur">
        <div class="mx-auto flex h-14 w-full max-w-[52rem] items-center gap-3 px-5">
          <img src=${icon} class="size-7 rounded-md" alt="Browser for AI Agent" />
          <h1 class="m-0 flex-1 text-base font-semibold text-highlight">${t('optionsTitle')}</h1>
          <dy-button small color="cancel" .icon=${icons.right} @click=${this.#openMarket}>${t('openMarket')}</dy-button>
          <dy-button small .icon=${icons.add} @click=${this.#openAdd}>${t('subscribeUrl')}</dy-button>
        </div>
      </header>
      <main class="mx-auto flex w-full max-w-[52rem] flex-col gap-8 px-5 py-8">
        <section>
          <header class="mb-3">
            <h2 class="m-0 text-sm font-semibold text-highlight">${t('myToolsets')}</h2>
            <p class="mt-1 mb-0 text-describe text-xs">${t('myToolsetsDesc')}</p>
          </header>
          <div class="divide-y divide-border overflow-hidden rounded-lg border border-border bg-white">
            ${
              toolsets.length
                ? repeat(
                    toolsets,
                    (t) => t.id,
                    (t) => html`<options-toolset-card .toolset=${t}></options-toolset-card>`,
                  )
                : html`<dy-empty class="py-12" text=${t('emptySubscribedToolsets')}></dy-empty>`
            }
          </div>
        </section>

        <section>
          <header class="mb-3">
            <h2 class="m-0 text-sm font-semibold text-highlight">${t('recommendedToolsets')}</h2>
            <p class="mt-1 mb-0 text-describe text-xs">${t('recommendedDesc')}</p>
          </header>
          <div class="divide-y divide-border overflow-hidden rounded-lg border border-border bg-white">
            ${repeat(
              this._recommended,
              (t) => t.url,
              (t) =>
                html`<options-toolset-card .recommended=${true} @subscription=${() => this.#addByUrl(t.url)} .toolset=${t}></options-toolset-card>`,
            )}
            <div
              class="group flex cursor-pointer items-center gap-3 px-4 py-3 text-describe transition hover:bg-slate-50 hover:text-primary"
              @click=${this.#openMarket}
            >
              <dy-avatar square>🧭</dy-avatar>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold text-highlight group-hover:text-primary">${t('exploreMoreToolsets')}</div>
                <div class="mt-0.5 truncate text-xs">${t('exploreMoreToolsetsDesc')}</div>
              </div>
              <dy-use .element=${icons.right}></dy-use>
            </div>
          </div>
        </section>
      </main>
    `;
  };
}
