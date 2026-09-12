import { createDecoratorTheme } from '@mantou/gem/helper/theme';
import { getAgentIconUrl } from '../../shared/agents.js';

const elementTheme = createDecoratorTheme({ icon: '' });

const style = css`
  :host(:where(:not([hidden]))) {
    display: inline-block;
    width: 1em;
    height: 1em;
    vertical-align: -0.15em;
    flex-shrink: 0;
    box-sizing: border-box;
    background-color: currentColor;
    -webkit-mask: ${elementTheme.icon} no-repeat center / contain;
    mask: ${elementTheme.icon} no-repeat center / contain;
  }
`;

@customElement('agent-icon')
@adoptedStyle(style)
@shadow()
export class AgentIconElement extends GemElement {
  @property src;
  @property agent;

  @elementTheme()
  #theme = () => {
    const url = this.src || getAgentIconUrl(this.agent);
    return { icon: url ? `url("${url}")` : '' };
  };
}
