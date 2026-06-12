import { icons } from 'duoyun-ui/lib/icons';
import { t } from '../../shared/i18n.js';

@customElement('market-toolset-card')
class MarketToolsetCardElement extends GemElement {
  @property toolset;
  @attribute url;
  @boolattribute subscribed;

  @emitter subscribe;
  @emitter refresh;

  #subscribe = () => {
    this.subscribe(null);
  };

  #refresh = () => {
    this.refresh(null);
  };

  @template()
  #content() {
    const toolset = this.toolset;
    if (!toolset) return html``;

    return html`
      <dy-drop-area
        accept=".js,.ts,.json,application/json,text/javascript,text/typescript"
        class="group flex items-center gap-4 rounded-lg border border-border bg-white/90 p-5 shadow-sm shadow-slate-200/60 transition hover:-translate-y-0.5 hover:border-primary hover:shadow-lg hover:shadow-indigo-500/10"
      >
        <span class="grid size-14 shrink-0 place-items-center rounded-lg bg-indigo-50 text-2xl shadow-inner shadow-indigo-100">
          ${toolset.icon || '📦'}
        </span>
        <div class="flex-1 min-w-0">
          <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span class="font-bold text-sm text-highlight">${toolset.name}</span>
            <dy-tag small>${t('toolCount', toolset.toolsCount ?? '?')}</dy-tag>
            <span class="text-xs text-describe">${t('installCount', toolset.installCount ?? 0)}</span>
          </div>
          <div class="mb-2 text-sm leading-6 text-describe">${toolset.description || t('noDescription')}</div>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral">
            <span v-if=${!!(toolset.author?.name || toolset.author?.email)}>${t('authorPrefix')}${toolset.author?.name || toolset.author?.email}</span>
            <span>${this.url}</span>
          </div>
        </div>
        <div class="shrink-0">
          <dy-button type="reverse" v-if=${!this.subscribed} @click=${this.#subscribe}>${t('subscribe')}</dy-button>
          <dy-button v-else type="reverse" .icon=${icons.refresh} @click=${this.#refresh}>${t('update')}</dy-button>
        </div>
      </dy-drop-area>
    `;
  }
}
