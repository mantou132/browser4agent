@customElement('market-stat-card')
class MarketStatCardElement extends GemElement {
  @attribute label;
  @attribute description;
  @boolattribute loading;
  @property value;

  @template()
  #content() {
    return html`
      <div class="rounded-lg border border-border bg-white/80 p-5 shadow-sm shadow-slate-200/60 backdrop-blur">
        <div class="text-2xl font-bold leading-8 text-highlight">
          ${this.loading ? html`<dy-placeholder class="w-12 h-7"></dy-placeholder>` : this.value}
        </div>
        <div class="mt-1 text-sm font-semibold text-text">${this.label}</div>
        <div class="mt-2 text-xs leading-5 text-describe">${this.description}</div>
      </div>
    `;
  }
}
