import { Toast } from 'duoyun-ui/elements/toast';
import { icons } from 'duoyun-ui/lib/icons';
import { blockContainer } from 'duoyun-ui/lib/styles';
import { t } from '../../shared/i18n.js';

@customElement('welcome-native-install-popover')
@adoptedStyle(blockContainer)
class WelcomeNativeInstallPopoverElement extends GemElement {
  #state = createState({
    installer: String(navigator.platform || '')
      .toLowerCase()
      .includes('win')
      ? 'scoop'
      : 'brew',
  });

  #packageManagers = [
    {
      value: 'brew',
      label: 'Homebrew',
      platform: t('packageInstallBrewPlatform'),
      description: t('packageInstallBrewDesc'),
      command: ['brew tap mantou132/tap', 'brew install browser4agent', 'browser4agent'].join('\n'),
    },
    {
      value: 'scoop',
      label: 'Scoop',
      platform: t('packageInstallScoopPlatform'),
      description: t('packageInstallScoopDesc'),
      command: [
        'scoop bucket add mantou132 https://github.com/mantou132/scoop-bucket',
        'scoop install browser4agent',
        'browser4agent',
      ].join('\n'),
    },
  ];

  get #currentPackageManager() {
    return this.#packageManagers.find(({ value }) => value === this.#state.installer) || this.#packageManagers[0];
  }

  #selectPackageManager = ({ detail }) => {
    this.#state({ installer: detail });
  };

  #copyCommand = async (command) => {
    try {
      await navigator.clipboard.writeText(command);
      Toast.open('success', t('copyCommandSuccess'));
    } catch {
      Toast.open('error', t('copyCommandFailure'));
    }
  };

  @template()
  #content = () => {
    const current = this.#currentPackageManager;

    return html`
      <div class="w-96 max-w-[calc(100vw-2rem)] text-left">
        <div>
          <h3 class="m-0 text-sm font-bold leading-5 text-highlight">${t('packageInstallTitle')}</h3>
          <p class="m-0 mt-1 text-xs leading-5 text-describe">${t('packageInstallDesc')}</p>
        </div>

        <dy-segmented
          class="mt-4"
          .options=${this.#packageManagers}
          .value=${current.value}
          @change=${this.#selectPackageManager}
        ></dy-segmented>

        <div class="mt-4 rounded-lg border border-border bg-slate-50 p-4">
          <div class="mb-3 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <strong class="block text-sm leading-5 text-highlight">${current.label}</strong>
              <span class="mt-0.5 block text-xs leading-5 text-describe">${current.platform}</span>
            </div>
            <dy-button
              small
              square
              color="cancel"
              class="shrink-0"
              .icon=${icons.copy}
              title=${t('copyCommand')}
              @click=${() => this.#copyCommand(current.command)}
            ></dy-button>
          </div>
          <pre class="m-0 overflow-x-auto rounded-md bg-slate-950 px-3 py-2.5 font-mono text-xs leading-5 text-slate-100"><code>${current.command}</code></pre>
          <p class="mb-0 mt-3 text-xs leading-5 text-describe">${current.description}</p>
        </div>
      </div>
    `;
  };
}
