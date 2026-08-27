import { t } from '../../shared/i18n.js';
import { getAgentIcon, icons } from '../../shared/icons.js';
import { displayHomePath } from '../../shared/path.js';

@customElement('agent-session-list')
class AgentSessionListElement extends GemElement {
  @boolattribute compact;
  @property sessions; // persisted sessions plus at most one in-memory draft
  @property sessionKey;
  @property home;
  @property loadingIds;
  @property deleting; // local session key being deleted, or null

  @emitter select; // detail: local session key
  @emitter create;
  @emitter remove; // detail: local session key

  #isActive = (session) => Boolean(session) && session.key === this.sessionKey;

  @template()
  #content = () => {
    const { compact, sessions, sessionKey, home, loadingIds, deleting } = this;
    const activeSession = sessions.find((session) => session.key === sessionKey);
    const sessionOptions = sessions.length
      ? sessions.map((session) => {
          const title = session.title || t('devtoolsPanelNewSession');
          const cwd = displayHomePath(session.cwd, home);
          return { label: title, description: cwd || undefined, value: session.key };
        })
      : [{ label: t('devtoolsPanelNoSessions'), value: '' }];

    return html`
      <aside
        class=${
          compact
            ? 'flex shrink-0 flex-col border-b border-border bg-bg-light/30'
            : 'flex w-64 shrink-0 flex-col border-r border-border bg-bg-light/30'
        }
      >
        <header
          class=${
            compact ? 'bg-bg px-3 py-2.5' : 'flex items-center justify-between gap-2 border-b border-border px-3 py-2.5'
          }
        >
          <div class="flex w-full items-center justify-between gap-2">
            <dy-use
              v-if=${compact && !!activeSession}
              class="size-4 shrink-0 text-describe"
              .element=${getAgentIcon(activeSession?.agent)}
            ></dy-use>
            <dy-picker
              v-if=${compact}
              class="min-w-0 flex-1 font-semibold"
              borderless
              fit
              .options=${sessionOptions}
              .value=${sessionKey}
              placeholder=${t('devtoolsPanelNoSessions')}
              @change=${(e) => this.select(e.detail)}
              aria-label=${t('devtoolsPanelSessions')}
            ></dy-picker>
            <span v-else class="font-semibold text-highlight">${t('devtoolsPanelSessions')}</span>
            <div class="flex items-center gap-1">
              <dy-button
                v-if=${compact && !!sessionKey && !loadingIds.includes(sessionKey) && deleting !== sessionKey}
                small
                square
                color="cancel"
                .icon=${icons.delete}
                title=${t('devtoolsPanelDelete')}
                @click=${() => this.remove(sessionKey)}
              ></dy-button>
              <dy-button small .icon=${icons.add} @click=${() => this.create(null)}>
                ${t('devtoolsPanelNew')}
              </dy-button>
            </div>
          </div>
        </header>
        <ul v-if=${!compact} class="m-0 flex-1 list-none overflow-auto p-0">
          <li v-if=${!sessions.length} class="px-3 py-4 text-center text-xs text-describe">
            ${t('devtoolsPanelNoSessions')}
          </li>
          ${sessions.map(
            (session) => html`
              <agent-session-item
                .session=${session}
                .home=${home}
                ?active=${this.#isActive(session)}
                ?loading=${loadingIds.includes(session.key)}
                ?deleting=${deleting === session.key}
                @select=${() => this.select(session.key)}
                @delete=${() => this.remove(session.key)}
              ></agent-session-item>
            `,
          )}
        </ul>
      </aside>
    `;
  };
}
