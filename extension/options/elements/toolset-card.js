// SWC bug: https://github.com/swc-project/swc/issues/11846

import { ContextMenu } from 'duoyun-ui/elements/contextmenu';
import { Toast } from 'duoyun-ui/elements/toast';
import { icons } from 'duoyun-ui/lib/icons';
import { loadToolset } from '../../shared/mcp/loader.js';
import { addToolset, removeToolset, setToolsetEnabled } from '../../shared/mcp/store.js';

@customElement('options-toolset-card')
class McpToolsetCardElement extends GemElement {
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
      width: '200px',
      activeElement: e.target,
      danger: true,
    });
    await removeToolset(this.toolset.id);
    this.update();
  };

  #refresh = async () => {
    try {
      const { meta, tools } = await loadToolset(this.toolset.url);
      await addToolset({
        ...this.toolset,
        name: meta.name,
        description: meta.description || '',
        icon: meta.icon || '',
        tools,
      });
      Toast.open('success', `已刷新：${meta.name}（${tools.length} 个工具）`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Toast.open('error', `刷新失败：${msg}`);
    }
  };

  #openMenu = (e) => {
    e.preventDefault();
    ContextMenu.open(
      [
        { text: '刷新', handle: () => this.#refresh() },
        { text: '删除', danger: true, handle: () => this.#remove(e) },
      ],
      { activeElement: e.target, openLeft: true },
    );
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
    return html`
      <div class="flex items-center gap-3.5 py-3.5 px-4 border border-border rounded-xl bg-bg transition-[border-color] hover:border-primary">
        <dy-avatar v-if=${isIconUrl} src=${icon} size="large" class="bg-neutral/10"></dy-avatar>
        <dy-avatar v-else size="large" class="bg-neutral/10">${icon || this.#initial(t.name)}</dy-avatar>
        <div class="flex-1 min-w-0">
          <dy-space class="mb-1" size="large">
            <span class="font-semibold text-sm text-highlight">${t.name}</span>
            <dy-tag color=${t.type === 'official' ? 'positive' : 'default'}>${t.type === 'official' ? '官方' : '社区'}</dy-tag>
          </dy-space>
          <div class="text-describe text-sm mb-1 truncate">${t.description || '—'}</div>
          <div class="text-neutral text-xs truncate">${t.url}</div>
        </div>
        <div class="flex items-center gap-2.5 shrink-0" v-if=${this.recommended}>
          <dy-button @click=${this.#subscribe}>订阅</dy-button>
        </div>
        <div class="flex items-center gap-2.5 shrink-0" v-else>
          <dy-switch neutral="positive" .checked=${!!t.enabled} @change=${this.#toggle}></dy-switch>
          <dy-button square color="cancel" .icon=${icons.more} @contextmenu=${this.#openMenu} @click=${this.#openMenu}></dy-button>
        </div>
      </div>
    `;
  }
}
