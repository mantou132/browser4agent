import { t } from '../../shared/i18n.js';
import { icons } from '../../shared/icons.js';
import { displayHomePath } from '../../shared/path.js';

@customElement('agent-session-list')
class AgentSessionListElement extends GemElement {
  @boolattribute compact;
  @property sessions; // persisted sessions: { sessionId, title?, cwd?, updatedAt? }
  @property sessionId;
  @property tempSession; // pinned entry for a session not persisted yet, or null
  @property home;
  @property loadingIds;
  @property pendingIds; // session ids with a prompt in flight
  @property deleting; // session id being deleted, or null

  @emitter select; // detail: sessionId or '__new__'
  @emitter create;
  @emitter remove; // detail: sessionId

  #isActive = (session) => Boolean(session) && session.sessionId === this.sessionId;

  @template()
  #content = () => {
    const { compact, sessions, sessionId, tempSession, home, loadingIds, pendingIds, deleting } = this;
    const sessionOptions = [
      ...(tempSession ? [{ label: tempSession.title, value: '__new__' }] : []),
      ...sessions.map((session) => {
        const title = session.title || session.sessionId;
        const cwd = displayHomePath(session.cwd, home);
        return { label: title, description: cwd || undefined, value: session.sessionId };
      }),
    ];

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
            <dy-picker
              v-if=${compact}
              class="min-w-0 flex-1 font-semibold"
              borderless
              fit
              .options=${sessionOptions}
              .value=${tempSession ? '__new__' : sessionId}
              placeholder=${t('devtoolsPanelNoSessions')}
              @change=${(e) => this.select(e.detail)}
              aria-label=${t('devtoolsPanelSessions')}
            ></dy-picker>
            <span v-else class="font-semibold text-highlight">${t('devtoolsPanelSessions')}</span>
            <div class="flex items-center gap-1">
              <dy-button
                v-if=${compact && !!sessionId && !pendingIds.includes(sessionId)}
                small
                square
                color="cancel"
                .icon=${icons.delete}
                title=${t('devtoolsPanelDelete')}
                @click=${() => this.remove(sessionId)}
              ></dy-button>
              <dy-button small .icon=${icons.add} @click=${() => this.create(null)}>
                ${t('devtoolsPanelNew')}
              </dy-button>
            </div>
          </div>
        </header>
        <ul v-if=${!compact} class="m-0 flex-1 list-none overflow-auto p-0">
          <li v-if=${!sessions.length && !tempSession} class="px-3 py-4 text-center text-xs text-describe">
            ${t('devtoolsPanelNoSessions')}
          </li>
          <agent-session-item
            v-if=${!!tempSession}
            .session=${tempSession}
            .home=${home}
            ?active=${this.#isActive(tempSession)}
          ></agent-session-item>
          ${sessions.map(
            (session) => html`
              <agent-session-item
                .session=${session}
                .home=${home}
                ?active=${this.#isActive(session)}
                ?loading=${loadingIds.includes(session.sessionId)}
                ?deleting=${deleting === session.sessionId}
                @select=${() => this.select(session.sessionId)}
                @delete=${() => this.remove(session.sessionId)}
              ></agent-session-item>
            `,
          )}
        </ul>
      </aside>
    `;
  };
}
