// SWC bug: https://github.com/swc-project/swc/issues/11846

import { ContextMenu } from 'duoyun-ui/elements/contextmenu';
import { Toast } from 'duoyun-ui/elements/toast';
import { icons } from 'duoyun-ui/lib/icons';
import { loadToolset } from '../../shared/loader.js';
import {
  addToolset,
  likeToolset,
  removeToolset,
  setToolsetEnabled,
  toolStore,
  unlikeToolset,
} from '../../shared/store.js';
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
    await ContextMenu.confirm(`确认移除工具集「${this.toolset.name}」？`, {
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
    Toast.open('success', `已刷新：${meta.name}（${tools.length} 个工具）`);
  };

  #like = async () => {
    await likeToolset(this.toolset.id, this.toolset.name);
    Toast.open('success', '感谢点赞');
    this.update();
  };

  #unlike = async () => {
    await unlikeToolset(this.toolset.id, this.toolset.name);
    Toast.open('success', '已取消点赞');
    this.update();
  };

  #openMenu = (e) => {
    e.preventDefault();
    const t = this.toolset;
    const isCommunity = t.type === 'community';
    const liked = isCommunity && isToolsetLiked(toolStore.likedToolsets, t.id);
    const items = [];
    if (isCommunity) {
      items.push(
        liked ? { text: '取消点赞', handle: () => this.#unlike() } : { text: '点赞', handle: () => this.#like() },
      );
    }
    items.push(
      { text: '刷新', handle: () => this.#refresh() },
      { text: '删除', danger: true, handle: () => this.#remove(e) },
    );
    ContextMenu.open(items, { activeElement: e.target, openLeft: true });
  };

  #subscribe = () => {
    // this.subscription(null)
    this.dispatchEvent(new CustomEvent('subscription'));
  };

  @template()
  #content() {
    const t = this.toolset;
    if (!t) return html``;

    const icon = t.icon || '';
    const isIconUrl = /^https?:\/\//.test(icon);
    const isOfficial = t.type === 'official';
    const isCustom = t.type === 'custom';
    const toolsCount = t.tools?.length ?? 0;
    return html`
      <div
        class="group flex items-center gap-4 rounded-lg border border-border bg-white/90 p-5 shadow-sm shadow-slate-200/60 transition hover:-translate-y-0.5 hover:border-primary hover:shadow-lg hover:shadow-indigo-500/10"
      >
        <dy-avatar v-if=${isIconUrl} src=${icon} size="large" square></dy-avatar>
        <dy-avatar v-else size="large" square>${icon || this.#initial(t.name)}</dy-avatar>
        <div class="flex-1 min-w-0">
          <dy-space class="mb-2" size="large">
            <span class="font-semibold text-sm text-highlight">${t.name}</span>
            <dy-tag small color=${isOfficial ? 'positive' : 'default'}>${isCustom ? '自定义' : isOfficial ? '官方' : '社区'}</dy-tag>
            <span class="text-xs text-describe">${toolsCount} 个工具</span>
          </dy-space>
          <div class="mb-2 text-sm leading-6 text-describe">${t.description || '暂无描述'}</div>
          <div class="truncate rounded-md bg-slate-50 px-3 py-2 text-xs text-neutral">${t.url}</div>
        </div>
        <div class="flex items-center gap-2.5 shrink-0" v-if=${this.recommended}>
          <dy-button type="reverse" @click=${this.#subscribe}>订阅</dy-button>
        </div>
        <div class="flex items-center gap-2.5 shrink-0" v-else>
          <dy-switch neutral="positive" .checked=${!!t.enabled} @change=${this.#toggle}></dy-switch>
          <dy-button square color="cancel" .icon=${icons.more} @contextmenu=${this.#openMenu} @click=${this.#openMenu}></dy-button>
        </div>
      </div>
    `;
  }
}
