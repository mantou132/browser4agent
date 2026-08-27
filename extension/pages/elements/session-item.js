import { t } from '../../shared/i18n.js';
import { getAgentIcon, icons } from '../../shared/icons.js';
import { displayHomePath } from '../../shared/path.js';

const agentNames = {
  claude: 'Claude Code',
  codex: 'Codex',
};

@customElement('agent-session-item')
class AgentSessionItemElement extends GemElement {
  @property session;
  @property home;
  @boolattribute active;
  @boolattribute loading;
  @boolattribute deleting;

  @emitter select;
  @emitter delete;

  #onSelect = () => {
    if (!this.deleting) {
      this.select(this.session?.key);
    }
  };

  #onDelete = (e) => {
    e.stopPropagation();
    if (!this.deleting && !this.loading) {
      this.delete(this.session?.key);
    }
  };

  @template()
  #content = () => {
    const { session, active, loading, deleting } = this;
    if (!session) return html``;

    const updatedAt = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : '';
    const title = session.title || t('devtoolsPanelNewSession');
    const agentName = agentNames[session.agent] || session.agent;

    return html`
      <li
        class=${classMap({
          'flex items-center gap-2 border-b border-border px-3 py-2.5 transition-colors': true,
          'cursor-pointer hover:bg-bg-hover': !deleting,
          'bg-bg-hover': active,
          'opacity-60 cursor-not-allowed': deleting,
        })}
        title=${`${agentName || ''} · ${session.sessionId || ''}`}
        @click=${this.#onSelect}
      >
        <span class="min-w-0 flex-1">
          <span class="flex min-w-0 items-center gap-1.5 font-medium text-highlight">
            <dy-use
              class="size-3.5 shrink-0 text-describe"
              .element=${getAgentIcon(session.agent)}
              title=${agentName || session.agent}
            ></dy-use>
            <span class="min-w-0 truncate">${title}</span>
          </span>
          <span v-if=${session.cwd} class="mt-0.5 block truncate font-mono text-xs text-describe" title=${session.cwd}>
            ${displayHomePath(session.cwd, this.home)}
          </span>
          <span v-if=${updatedAt} class="block truncate text-xs text-describe mt-0.5">${updatedAt}</span>
        </span>
        <dy-use
          v-if=${loading && !deleting}
          class="size-3.5 shrink-0 text-describe"
          .element=${icons.loading}
        ></dy-use>
        <dy-use
          v-if=${!deleting && !loading}
          class="size-3.5 shrink-0 cursor-pointer text-describe hover:text-negative transition-colors"
          .element=${icons.close}
          title=${t('devtoolsPanelDelete')}
          @click=${this.#onDelete}
        ></dy-use>
      </li>
    `;
  };
}
