import { hotkeys } from 'duoyun-ui/lib/hotkeys';
import { t } from '../../shared/i18n.js';
import { getAgentIcon } from '../../shared/icons.js';
import { displayHomePath } from '../../shared/path.js';

@customElement('agent-new-session-picker')
class AgentNewSessionPickerElement extends GemElement {
  @property complete;
  @property initialValue;
  @property home;
  @property agents;
  @property initialAgent;

  @emitter confirm; // detail: { agent, cwd }

  #s = createState({
    value: '',
    directories: [],
    loading: true,
    error: '',
    activeIndex: 0,
    agent: '',
  });
  #activeDirectoryRef = createRef();

  @willMount()
  #init = () => {
    const agents = this.agents || [];
    const agent = agents.some((item) => item.id === this.initialAgent) ? this.initialAgent : agents[0]?.id || '';
    this.#s({ agent });
    this.#update(this.#directoryInput(this.initialValue));
  };

  @effect((i) => [i.#s.activeIndex, i.#s.directories])
  #scrollActive = () => {
    this.#activeDirectoryRef.value?.scrollIntoView({ block: 'nearest' });
  };

  #update = async (value) => {
    this.#s({
      value,
      directories: [],
      loading: true,
      error: '',
      activeIndex: 0,
    });
    try {
      const result = await this.complete?.(value);
      const directories = [...(result.directories || [])];
      if (result.isDirectory && result.value) directories.unshift(result.value);
      this.#s({
        value: value || this.#directoryInput(result.value),
        directories,
        loading: false,
      });
    } catch (err) {
      this.#s({ directories: [], loading: false, error: err.message });
    }
  };

  #directoryInput = (value) => {
    const display = displayHomePath(value, this.home);
    if (!display || display === '/') return display;
    return `${display.replace(/[\\/]+$/, '')}/`;
  };

  #select = (value) => {
    this.#update(this.#directoryInput(value));
  };

  #confirm = (cwd) => {
    if (this.#s.agent) this.confirm({ agent: this.#s.agent, cwd });
  };

  #onKeydown = hotkeys(
    {
      tab: () => {
        const { directories, activeIndex } = this.#s;
        if (directories[activeIndex]) this.#select(directories[activeIndex]);
      },
      down: () => {
        const { directories, activeIndex } = this.#s;
        if (directories.length) this.#s({ activeIndex: (activeIndex + 1) % directories.length });
      },
      up: () => {
        const { directories, activeIndex } = this.#s;
        if (directories.length) this.#s({ activeIndex: (activeIndex - 1 + directories.length) % directories.length });
      },
      enter: () => {
        const { directories, activeIndex } = this.#s;
        if (directories[activeIndex]) this.#confirm(directories[activeIndex]);
      },
    },
    { stopPropagation: true },
  );

  @template()
  #content = () => {
    const { value, directories, loading, error, activeIndex, agent } = this.#s;
    const agents = this.agents || [];
    return html`
      <section class="w-full rounded-lg border border-border bg-bg shadow-lg">
        <header class="border-b border-border px-4 py-3">
          <h2 class="m-0 text-sm font-semibold text-highlight">${t('devtoolsNewSessionTitle')}</h2>
        </header>
        <div class="px-4 py-3">
          <fieldset class="m-0 mb-3 min-w-0 border-0 p-0">
            <legend class="mb-1.5 p-0 text-xs font-medium text-describe">${t('devtoolsAgentLabel')}</legend>
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
              ${agents.map(
                (item) => html`
                  <button
                    type="button"
                    aria-pressed=${agent === item.id}
                    class=${classMap({
                      'flex min-w-0 cursor-pointer items-center gap-2 rounded border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus': true,
                      'border-primary bg-primary/10 text-highlight': agent === item.id,
                      'border-border bg-bg-light/40 text-text hover:bg-bg-hover': agent !== item.id,
                    })}
                    @click=${() => this.#s({ agent: item.id })}
                  >
                    <dy-use class="size-4 shrink-0" .element=${getAgentIcon(item.id)}></dy-use>
                    <span class="truncate font-medium">${item.name}</span>
                  </button>
                `,
              )}
            </div>
          </fieldset>
          <label class="mb-1.5 block text-xs font-medium text-describe" for="agent-new-session-cwd-input">
            ${t('devtoolsCwdTitle')}
          </label>
          <dy-input
            id="agent-new-session-cwd-input"
            autofocus
            class="w-full font-mono"
            placeholder=${t('devtoolsCwdPlaceholder')}
            .value=${value}
            @change=${(event) => this.#update(event.detail)}
            @keydown=${this.#onKeydown}
          ></dy-input>
          <div class="mt-2 h-52 overflow-auto rounded border border-border bg-bg-light/40">
            <div v-if=${loading} class="grid h-full place-items-center text-describe"><dy-loading></dy-loading></div>
            <div v-if=${!loading && !directories.length} class="grid h-full place-items-center text-xs text-describe">
              ${t('devtoolsCwdNoDirectories')}
            </div>
            ${directories.map(
              (directory, index) => html`
                <button
                  ${index === activeIndex ? this.#activeDirectoryRef : undefined}
                  type="button"
                  aria-current=${index === activeIndex}
                  class=${classMap({
                    'block w-full truncate border-0 border-b border-border px-3 py-2 text-left font-mono text-xs text-text': true,
                    'bg-bg-hover font-medium': index === activeIndex,
                    'bg-transparent': index !== activeIndex,
                    'cursor-pointer hover:bg-bg-hover': true,
                  })}
                  title=${directory}
                  @click=${() => this.#confirm(directory)}
                >
                  ${displayHomePath(directory, this.home)}
                </button>
              `,
            )}
          </div>
          <div v-if=${error} class="mt-2 text-xs text-negative">${error}</div>
        </div>
      </section>
    `;
  };
}
