const style = css`
  .item {
    margin-block-end: 1.8em;
    width: 100%;
  }
`;

@customElement('market-tool-editor-param')
@adoptedStyle(style)
class MarketToolEditorParamElement extends GemElement {
  @property value;
  @emitter change;

  #state = createState();

  #onChange = (k, e) => {
    e.stopPropagation();
    this.#state({ [k]: e.detail });
    // this.change(this.#state);
    this.dispatchEvent(new CustomEvent('change', { detail: this.#state }));
  };

  render = () => {
    return html`
      <dy-input class="item" .value=${this.value} @change=${(e) => this.#onChange('key', e)}></dy-input>
    `;
  };
}
