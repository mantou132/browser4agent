import { t } from '../../shared/i18n.js';

const TYPE_OPTIONS = [
  { label: 'string', value: 'string' },
  { label: 'number', value: 'number' },
  { label: 'boolean', value: 'boolean' },
];

const style = css`
  :scope {
    display: grid;
    grid-template-columns: 1fr 8rem auto;
    gap: 0.625rem;
    align-items: center;
    margin-block-end: 1rem;
    width: 100%;
    border: 1px solid var(--color-border);
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--color-bg-light) 64%, white);
    padding: 0.75rem;
  }
  .desc {
    grid-column: 1 / -1;
  }
  .required {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    justify-content: flex-end;
    font-size: 0.75rem;
    white-space: nowrap;
    color: var(--color-describe);
  }
  * {
    inline-size: auto;
  }
`;

@customElement('market-tool-editor-param')
@adoptedStyle(style)
class MarketToolEditorParamElement extends GemElement {
  @property value;
  @emitter change;

  #emit = (patch) => {
    this.change({ ...this.value, ...patch });
  };

  render = () => {
    const v = this.value || {};
    return html`
      <dy-input
        placeholder=${t('paramNamePlaceholder')}
        .value=${v.name}
        @change=${(e) => this.#emit({ name: e.detail })}
      ></dy-input>
      <dy-select
        .value=${v.type}
        .options=${TYPE_OPTIONS}
        @change=${(e) => this.#emit({ type: e.detail })}
      ></dy-select>
      <label class="required">
        <dy-switch
          .checked=${!!v.required}
          @change=${(e) => this.#emit({ required: e.detail })}
        ></dy-switch>
        ${t('required')}
      </label>
      <dy-input
        class="desc"
        placeholder=${t('paramDescriptionPlaceholder')}
        .value=${v.description}
        @change=${(e) => this.#emit({ description: e.detail })}
      ></dy-input>
    `;
  };
}
