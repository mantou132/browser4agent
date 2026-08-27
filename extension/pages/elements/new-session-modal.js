import { DuoyunModalElement } from 'duoyun-ui/elements/modal';
import { theme } from 'duoyun-ui/lib/theme';

const style = css`
  :host {
    background-color: color-mix(in srgb, ${theme.backgroundColor} 90%, transparent);
  }

  .mask {
    background-color: transparent;
  }
`;

@customElement('agent-new-session-modal')
@adoptedStyle(style)
class AgentNewSessionModalElement extends DuoyunModalElement {}
