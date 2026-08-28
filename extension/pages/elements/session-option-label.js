import { getAgentIcon } from '../../shared/icons.js';

const style = css`
  :host(:where(:not([hidden]))) {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.5em;
  }

  dy-use {
    width: 1em;
    height: 1em;
    flex-shrink: 0;
  }

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

@customElement('agent-session-option-label')
@adoptedStyle(style)
@shadow()
class AgentSessionOptionLabelElement extends GemElement {
  @property sessionAgent;
  @property sessionTitle;

  @template()
  #content = () => html`
    <dy-use .element=${getAgentIcon(this.sessionAgent)}></dy-use>
    <span>${this.sessionTitle}</span>
  `;
}
