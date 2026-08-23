import { t } from '../../shared/i18n.js';
import { icons } from '../../shared/icons.js';

/** The emitter must not be named `remove`: that would shadow
 * `Element.prototype.remove()` and break lit-html's node removal. */
@customElement('agent-attachment')
class AgentAttachmentElement extends GemElement {
  @property attachment;
  @boolattribute inverted;
  @boolattribute small;
  @boolattribute removable;

  @emitter requestRemove;

  #preview = () => {
    const { previewUrl, name } = this.attachment || {};
    return html`
      <div class="flex flex-col items-center">
        <img class="max-h-80 max-w-xs object-contain" src=${previewUrl} alt="" />
        <span class="mt-1 text-center text-xs text-describe">${name}</span>
      </div>
    `;
  };

  @template()
  #content = () => {
    const item = this.attachment;
    if (!item) return html``;
    const previewable = item.kind === 'image' && item.previewUrl;
    const chip = html`
      <span
        class=${classMap({
          'flex items-center text-xs': true,
          'h-9 gap-1.5 rounded-md border border-border bg-bg-light pl-1 pr-1.5 text-text': !this.inverted,
          'h-5 gap-1 rounded-xs bg-white/25 px-1 text-white': this.inverted,
        })}
      >
        <img
          v-if=${item.kind === 'image'}
          class=${classMap({ 'object-cover rounded-xs': true, 'size-7': !this.small, 'size-4': this.small })}
          src=${item.previewUrl}
          alt=""
        />
        <dy-use
          v-else
          class=${classMap({ 'shrink-0': true, 'size-4 text-describe': !this.inverted, 'size-3.5': this.inverted })}
          .element=${icons.file}
        ></dy-use>
        <span class=${this.small ? 'max-w-36 truncate' : 'max-w-40 truncate'} title=${item.name}>${item.name}</span>
        <button
          v-if=${this.removable}
          type="button"
          class="grid size-4 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-describe transition-colors hover:text-negative"
          title=${t('devtoolsPanelRemoveAttachment')}
          aria-label=${t('devtoolsPanelRemoveAttachment')}
          @click=${() => this.requestRemove(item.id)}
        >
          <dy-use class="size-3" .element=${icons.close}></dy-use>
        </button>
      </span>
    `;
    return html`
      <dy-popover position="auto" ?disabled=${!previewable} .content=${previewable ? this.#preview() : ''}>
        ${chip}
      </dy-popover>
    `;
  };
}
