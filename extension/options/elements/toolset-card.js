import { ContextMenu } from 'duoyun-ui/elements/contextmenu';
import { Toast } from 'duoyun-ui/elements/toast';
import { icons } from 'duoyun-ui/lib/icons';
import { t } from '../../shared/i18n.js';
import { loadToolset } from '../../shared/loader.js';
import {
  addToolset,
  likeToolset,
  removeToolset,
  setToolsetEnabled,
  toolStore,
  unlikeToolset,
} from '../../shared/tool-store.js';
import { isToolsetLiked } from '../../shared/toolsets.js';

@customElement('options-toolset-card')
class OptionsToolsetCardElement extends GemElement {
  @property toolset;
  @boolattribute recommended;
  @emitter subscription;

  #initial = (name) => ((name || '').trim()[0] || '?').toUpperCase();

  #toggle = (e) => {
    setToolsetEnabled(this.toolset.id, e.detail);
    this.update();
  };

  #remove = async (e) => {
    await ContextMenu.confirm(t('removeToolsetConfirm', this.toolset.name), {
      openLeft: true,
      activeElement: e.target,
      danger: true,
    });
    await removeToolset(this.toolset.id);
    this.update();
  };

  #refresh = async () => {
    const { meta, tools } = await loadToolset(this.toolset.url);
    await addToolset({ ...this.toolset, ...meta, tools });
    Toast.open('success', t('refreshedToolset', [meta.name, tools.length]));
  };

  #like = async () => {
    await likeToolset(this.toolset.id, this.toolset.name);
    Toast.open('success', t('thanksForLike'));
    this.update();
  };

  #unlike = async () => {
    await unlikeToolset(this.toolset.id, this.toolset.name);
    Toast.open('success', t('unliked'));
    this.update();
  };

  #openMenu = (e) => {
    e.preventDefault();
    const toolset = this.toolset;
    const isCommunity = toolset.type === 'community';
    const liked = isCommunity && isToolsetLiked(toolStore.likedToolsets, toolset.id);
    const items = [];
    if (isCommunity) {
      if (liked) {
        items.push({ text: t('unlike'), handle: () => this.#unlike() });
      } else {
        items.push({ text: t('like'), handle: () => this.#like() });
      }
    }
    items.push(
      { text: t('refresh'), handle: () => this.#refresh() },
      { text: t('delete'), danger: true, handle: () => this.#remove(e) },
    );
    ContextMenu.open(items, { activeElement: e.target, openLeft: true });
  };

  #subscribe = () => {
    this.subscription(null);
  };

  @template()
  #content() {
    const toolset = this.toolset;
    if (!toolset) return html``;

    const icon = toolset.icon || '';
    const isIconUrl = /^https?:\/\//.test(icon);
    const isOfficial = toolset.type === 'official';
    const isCustom = toolset.type === 'custom';
    const toolsCount = toolset.tools?.length ?? 0;
    return html`
      <div
        class="group flex items-center gap-4 rounded-lg border border-border bg-white/90 p-5 shadow-sm shadow-slate-200/60 transition hover:-translate-y-0.5 hover:border-primary hover:shadow-lg hover:shadow-indigo-500/10"
      >
        <dy-avatar v-if=${isIconUrl} src=${icon} size="large" square></dy-avatar>
        <dy-avatar v-else size="large" square>${icon || this.#initial(toolset.name)}</dy-avatar>
        <div class="flex-1 min-w-0">
          <dy-space class="mb-2" size="large">
            <span class="font-semibold text-sm text-highlight">${toolset.name}</span>
            <dy-tag small color=${isOfficial ? 'positive' : 'default'}>${isCustom ? t('custom') : isOfficial ? t('official') : t('community')}</dy-tag>
            <span class="text-xs text-describe">${t('toolCount', toolsCount)}</span>
          </dy-space>
          <div class="mb-2 text-sm leading-6 text-describe">${toolset.description || t('noDescription')}</div>
          <div class="truncate rounded-md bg-slate-50 px-3 py-2 text-xs text-neutral">${toolset.url}</div>
        </div>
        <div class="flex items-center gap-2.5 shrink-0" v-if=${this.recommended}>
          <dy-button type="reverse" @click=${this.#subscribe}>${t('subscribe')}</dy-button>
        </div>
        <div class="flex items-center gap-2.5 shrink-0" v-else>
          <dy-switch neutral="positive" .checked=${!!toolset.enabled} @change=${this.#toggle}></dy-switch>
          <dy-button square color="cancel" .icon=${icons.more} @contextmenu=${this.#openMenu} @click=${this.#openMenu}></dy-button>
        </div>
      </div>
    `;
  }
}
