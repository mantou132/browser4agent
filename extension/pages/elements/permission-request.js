import { t } from '../../shared/i18n.js';

@customElement('agent-permission-request')
class AgentPermissionRequestElement extends GemElement {
  @property request;

  @emitter decision;

  #choose = (optionId) => this.decision(optionId);

  @template()
  #content = () => {
    const { toolCall = {}, options = [] } = this.request || {};
    const input = toolCall.rawInput;

    return html`
      <section class="my-2 w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-bg-light/60">
        <header class="px-3 py-2">
          <div class="flex min-w-0 items-center justify-between gap-3">
            <h2 class="m-0 shrink-0 text-sm font-semibold text-highlight">${t('devtoolsPermissionTitle')}</h2>
            <span
              v-if=${toolCall.kind}
              class="min-w-0 truncate font-mono text-xs text-describe"
              title=${toolCall.kind}
            >${toolCall.kind}</span>
          </div>
          <p
            class="mb-0 mt-0.5 min-w-0 truncate font-mono text-xs text-describe"
            title=${toolCall.title || ''}
          >${toolCall.title || t('devtoolsPermissionToolFallback')}</p>
        </header>
        <details v-if=${input !== undefined} class="border-t border-border text-xs">
          <summary class="cursor-pointer select-none px-3 py-1.5 text-describe hover:text-text">
            ${t('devtoolsToolInput')}
          </summary>
          <pre
            class="m-0 max-h-40 overflow-auto border-t border-border bg-bg-light p-2.5 font-mono leading-relaxed text-text"
          >${JSON.stringify(input, null, 2)}</pre>
        </details>
        <footer class="flex min-w-0 flex-wrap justify-end gap-2 border-t border-border px-3 py-2">
          <dy-button class="min-w-0 max-w-full" small color="cancel" @click=${() => this.#choose(null)}>
            <span class="wrap-anywhere whitespace-normal text-center leading-snug">
              ${t('devtoolsPermissionCancel')}
            </span>
          </dy-button>
          ${options.map((option) => {
            const reject = option.kind?.startsWith('reject');
            return html`
              <dy-button
                class="min-w-0 max-w-full"
                small
                type=${reject ? null : 'solid'}
                color=${reject ? 'cancel' : 'normal'}
                @click=${() => this.#choose(option.optionId)}
              >
                <span
                  class="wrap-anywhere whitespace-normal text-center leading-snug"
                  title=${option.name || ''}
                >${option.name}</span>
              </dy-button>
            `;
          })}
        </footer>
      </section>
    `;
  };
}
