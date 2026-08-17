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
      <section class="mx-auto my-2 w-full max-w-xl rounded-lg border border-border bg-bg shadow-lg">
        <header class="border-b border-border px-4 py-3">
          <h2 class="m-0 text-sm font-semibold text-highlight">${t('devtoolsPermissionTitle')}</h2>
          <p class="mb-0 mt-1 text-xs text-describe">${toolCall.title || t('devtoolsPermissionToolFallback')}</p>
        </header>
        <div class="max-h-72 overflow-auto px-4 py-3">
          <div v-if=${toolCall.kind} class="mb-2 text-xs text-describe">${toolCall.kind}</div>
          <pre
            v-if=${input !== undefined}
            class="m-0 overflow-auto rounded border border-border bg-bg-light p-3 font-mono text-xs leading-relaxed text-text"
          >${JSON.stringify(input, null, 2)}</pre>
        </div>
        <footer class="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
          <dy-button color="cancel" @click=${() => this.#choose(null)}>
            ${t('devtoolsPermissionCancel')}
          </dy-button>
          ${options.map((option) => {
            const reject = option.kind?.startsWith('reject');
            return html`
              <dy-button
                type=${reject ? null : 'solid'}
                color=${reject ? 'cancel' : 'normal'}
                @click=${() => this.#choose(option.optionId)}
              >
                ${option.name}
              </dy-button>
            `;
          })}
        </footer>
      </section>
    `;
  };
}
