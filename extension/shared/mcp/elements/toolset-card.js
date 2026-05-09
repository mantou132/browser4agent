// biome-ignore-all lint/correctness/noUnusedPrivateClassMembers: gem decorators consume private fields
// biome-ignore-all lint/correctness/noUnusedVariables: gem @customElement consumes the class

import { adoptedStyle, css, customElement, GemElement, html, property, template } from '@mantou/gem';
import { Modal } from 'duoyun-ui/elements/modal';
import { removeToolset, setToolsetEnabled } from '../store.js';

import 'duoyun-ui/elements/avatar';
import 'duoyun-ui/elements/switch';
import 'duoyun-ui/elements/tag';

const style = css({
  $: `
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    background: #fff;
    transition: border-color 0.15s;
    &:hover { border-color: #3b82f6; }
  `,
  body: `
    flex: 1;
    min-width: 0;
  `,
  titleRow: `
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  `,
  title: `
    font-weight: 600;
    font-size: 14px;
    color: #111827;
  `,
  desc: `
    color: #6b7280;
    font-size: 13px;
    margin-bottom: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  url: `
    color: #9ca3af;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  actions: `
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  `,
  menuBtn: `
    width: 28px;
    height: 28px;
    border: 0;
    background: transparent;
    color: #6b7280;
    border-radius: 6px;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    &:hover { background: #f3f4f6; }
  `,
});

@customElement('mcp-toolset-card')
@adoptedStyle(style)
class McpToolsetCardElement extends GemElement {
  @property toolset;

  #initial = (name) => ((name || '').trim()[0] || '?').toUpperCase();

  #toggle = (e) => {
    if (!this.toolset) return;
    setToolsetEnabled(this.toolset.id, e.detail);
  };

  #remove = async () => {
    if (!this.toolset) return;
    await Modal.confirm(`确认移除工具集「${this.toolset.name}」？`);
    await removeToolset(this.toolset.id);
  };

  @template()
  #content = () => {
    const t = this.toolset;
    if (!t) return html``;
    const typeLabel = t.type === 'official' ? '官方' : '社区';
    const icon = t.icon || '';
    const isIconUrl = /^https?:\/\//.test(icon);
    return html`
      <dy-avatar v-if=${isIconUrl} src=${icon} size="large"></dy-avatar>
      <dy-avatar v-else size="large">${icon || this.#initial(t.name)}</dy-avatar>
      <div class=${style.body}>
        <div class=${style.titleRow}>
          <span class=${style.title}>${t.name}</span>
          <dy-tag small color=${t.type === 'official' ? 'positive' : 'informative'}>${typeLabel}</dy-tag>
        </div>
        <div class=${style.desc}>${t.description || '—'}</div>
        <div class=${style.url}>${t.url}</div>
      </div>
      <div class=${style.actions}>
        <dy-switch .checked=${!!t.enabled} @change=${this.#toggle}></dy-switch>
        <button class=${style.menuBtn} title="移除" aria-label="移除" @click=${this.#remove}>×</button>
      </div>
    `;
  };
}
