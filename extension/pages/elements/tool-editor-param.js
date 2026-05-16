const TYPE_OPTIONS = [
  { label: 'string', value: 'string' },
  { label: 'number', value: 'number' },
  { label: 'boolean', value: 'boolean' },
];

const style = css`
  :scope {
    display: grid;
    grid-template-columns: 1fr 8rem auto;
    gap: 0.5rem;
    align-items: center;
    margin-block-end: 1.8em;
    width: 100%;
  }
  .desc {
    grid-column: 1 / -1;
  }
  .required {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    white-space: nowrap;
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
    // this.change({ ...this.#value, ...patch });
    this.dispatchEvent(new CustomEvent('change', { detail: { ...this.value, ...patch } }));
  };

  render = () => {
    const v = this.value || {};
    return html`
      <dy-input
        placeholder="参数名"
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
        必填
      </label>
      <dy-input
        class="desc"
        placeholder="参数描述"
        .value=${v.description}
        @change=${(e) => this.#emit({ description: e.detail })}
      ></dy-input>
    `;
  };
}
