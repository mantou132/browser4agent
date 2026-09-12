const style = css`
  :host(:where(:not([hidden]))) {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.5em;
  }

  agent-icon {
    width: 1.15em;
    height: 1.15em;
    flex-shrink: 0;
  }

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

@customElement('agent-option-label')
@adoptedStyle(style)
@shadow()
export class AgentOptionLabelElement extends GemElement {
  @property agent;
  @property name;
  @property icon;

  @template()
  #content = () => html`
    <agent-icon .src=${this.icon} .agent=${this.agent}></agent-icon>
    <span>${this.name}</span>
  `;
}
