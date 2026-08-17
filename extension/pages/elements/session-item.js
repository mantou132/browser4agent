import { icons } from 'duoyun-ui/lib/icons';
import { t } from '../../shared/i18n.js';
import { displayHomePath } from '../../shared/path.js';

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
    if (!this.session?.temp && !this.deleting && !this.loading) {
      this.select(this.session?.sessionId);
    }
  };

  #onDelete = (e) => {
    e.stopPropagation();
    if (!this.deleting && !this.loading && !this.session?.temp) {
      this.delete(this.session?.sessionId);
    }
  };

  @template()
  #content = () => {
    const { session, active, loading, deleting } = this;
    if (!session) return html``;

    const updatedAt = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : '';
    const title = session.title || session.sessionId;

    return html`
      <li
        class=${classMap({
          'flex items-center gap-2 border-b border-border px-3 py-2.5 transition-colors': true,
          'cursor-pointer hover:bg-bg-hover': !deleting && !loading,
          'bg-bg-hover': active,
          'opacity-60 cursor-not-allowed': deleting,
        })}
        title=${session.sessionId || ''}
        @click=${this.#onSelect}
      >
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium text-highlight">${title}</span>
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
          v-if=${!deleting && !loading && !session.temp}
          class="size-3.5 shrink-0 cursor-pointer text-describe hover:text-negative transition-colors"
          .element=${icons.close}
          title=${t('devtoolsPanelDelete')}
          @click=${this.#onDelete}
        ></dy-use>
      </li>
    `;
  };
}
