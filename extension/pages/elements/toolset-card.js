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
        class="group box-border flex h-full flex-col gap-4 rounded-xl border border-border bg-white p-5 shadow-sm shadow-slate-200/60 transition hover:-translate-y-0.5 hover:border-primary hover:shadow-lg hover:shadow-indigo-500/10"
      >
        <div class="flex items-start gap-4">
          <span class="grid size-16 shrink-0 place-items-center rounded-2xl bg-indigo-50 text-3xl shadow-inner shadow-indigo-100">
            ${toolset.icon || '📦'}
          </span>
          <div class="min-w-0 flex-1">
            <div class="truncate text-base font-bold text-highlight">${toolset.name}</div>
            <div class="mt-0.5 truncate text-xs text-neutral" v-if=${!!(toolset.author?.name || toolset.author?.email)}>
              ${t('authorPrefix')}${toolset.author?.name || toolset.author?.email}
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <dy-tag small>${t('toolCount', toolset.toolsCount ?? '?')}</dy-tag>
              <span class="text-xs text-describe">${t('installCount', toolset.installCount ?? 0)}</span>
            </div>
          </div>
        </div>
        <div class="flex-1">
          <div class="line-clamp-2 text-sm leading-6 text-describe">${toolset.description || t('noDescription')}</div>
        </div>
        <div class="flex items-center gap-3 border-t border-border pt-4">
          <span class="min-w-0 flex-1 truncate text-xs text-neutral" title=${this.url}>${this.url}</span>
          <dy-button type="reverse" v-if=${!this.subscribed} @click=${this.#subscribe}>${t('subscribe')}</dy-button>
          <dy-button v-else type="reverse" .icon=${icons.refresh} @click=${this.#refresh}>${t('update')}</dy-button>
        </div>
      </dy-drop-area>
    `;
  }
}
