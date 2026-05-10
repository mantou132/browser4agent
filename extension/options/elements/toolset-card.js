// SWC bug: https://github.com/swc-project/swc/issues/11846

import { Modal } from 'duoyun-ui/elements/modal';
import { removeToolset, setToolsetEnabled } from '../../shared/mcp/store.js';

@customElement('options-toolset-card')
class McpToolsetCardElement extends GemElement {
  @property toolset;

  #initial = (name) => ((name || '').trim()[0] || '?').toUpperCase();

  #toggle = (e) => {
    setToolsetEnabled(this.toolset.id, e.detail);
    this.update();
  };

  #remove = async () => {
    await Modal.confirm(`确认移除工具集「${this.toolset.name}」？`);
    await removeToolset(this.toolset.id);
    this.update();
  };

  @template()
  #content() {
    const t = this.toolset;
    if (!t) return html``;
    const typeLabel = t.type === 'official' ? '官方' : '社区';
    const icon = t.icon || '';
    const isIconUrl = /^https?:\/\//.test(icon);
    return html`
      <div class="flex items-center gap-3.5 py-3.5 px-4 border border-border rounded-[10px] bg-bg transition-[border-color] hover:border-primary">
        <dy-avatar v-if=${isIconUrl} src=${icon} size="large"></dy-avatar>
        <dy-avatar v-else size="large">${icon || this.#initial(t.name)}</dy-avatar>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="font-semibold text-sm text-highlight">${t.name}</span>
            <dy-tag small color=${t.type === 'official' ? 'positive' : 'informative'}>${typeLabel}</dy-tag>
          </div>
          <div class="text-describe text-[13px] mb-1 truncate">${t.description || '—'}</div>
          <div class="text-neutral text-xs truncate">${t.url}</div>
        </div>
        <div class="flex items-center gap-2.5 shrink-0">
          <dy-switch neutral="positive" .checked=${!!t.enabled} @change=${this.#toggle}></dy-switch>
          <button class="w-7 h-7 border-0 bg-transparent text-describe rounded-normal cursor-pointer text-lg leading-none hover:bg-bg-hover" title="移除" aria-label="移除" @click=${this.#remove}>×</button>
        </div>
      </div>
    `;
  }
}
