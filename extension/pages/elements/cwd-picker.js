import { hotkeys } from 'duoyun-ui/lib/hotkeys';
import { t } from '../../shared/i18n.js';
import { displayHomePath } from '../../shared/path.js';

@customElement('agent-cwd-picker')
class AgentCwdPickerElement extends GemElement {
  @property complete;
  @property initialValue;
  @property home;

  @emitter confirm;

  #s = createState({
    value: '',
    directories: [],
    loading: true,
    error: '',
    activeIndex: 0,
  });

  #requestId = 0;

  @mounted()
  #init = () => this.#update(this.#directoryInput(this.initialValue));

  @effect((element) => [element.#s.activeIndex, element.#s.directories])
  #scrollActive = () => {
    this.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  };

  #update = async (value) => {
    const requestId = ++this.#requestId;
    this.#s({
      value,
      directories: [],
      loading: true,
      error: '',
      activeIndex: 0,
    });
    try {
      const result = await this.complete?.(value);
      if (requestId !== this.#requestId) return;
      const directories = [...(result.directories || [])];
      if (result.isDirectory && result.value) directories.unshift(result.value);
      this.#s({
        value: value || this.#directoryInput(result.value),
        directories,
        loading: false,
      });
    } catch (err) {
      if (requestId !== this.#requestId) return;
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
        if (directories[activeIndex]) this.confirm(directories[activeIndex]);
      },
    },
    { stopPropagation: true },
  );

  @template()
  #content = () => {
    const { value, directories, loading, error, activeIndex } = this.#s;
    return html`
      <section class="w-full rounded-lg border border-border bg-bg shadow-lg">
        <header class="border-b border-border px-4 py-3">
          <h2 class="m-0 text-sm font-semibold text-highlight">${t('devtoolsCwdTitle')}</h2>
        </header>
        <div class="px-4 py-3">
          <dy-input
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
                  type="button"
                  aria-current=${index === activeIndex}
                  class=${classMap({
                    'block w-full truncate border-0 border-b border-border px-3 py-2 text-left font-mono text-xs text-text': true,
                    'bg-bg-hover font-medium': index === activeIndex,
                    'bg-transparent': index !== activeIndex,
                    'cursor-pointer hover:bg-bg-hover': true,
                  })}
                  title=${directory}
                  @click=${() => this.confirm(directory)}
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
