import { icons } from 'duoyun-ui/lib/icons';
import { setPageI18n, t } from '../shared/i18n.js';

const REPO_URL = 'https://github.com/mantou132/browser4agent';
const DOWNLOAD_URL = `${REPO_URL}/releases/latest/download`;

setPageI18n('welcomeTitle');

const style = css`
  :scope {
    display: block;
    min-height: 100vh;
    background:
      radial-gradient(circle at 85% 14%, rgba(129, 140, 248, 0.18), transparent 32rem),
      radial-gradient(circle at 10% 90%, rgba(139, 92, 246, 0.13), transparent 28rem),
      linear-gradient(135deg, white 0%, #f8fafc 52%, #f5f3ff 100%);
  }
`;

@customElement('agent-welcome-page')
@adoptedStyle(style)
class AgentWelcomePageElement extends GemElement {
  #platforms = [
    {
      name: 'Windows',
      type: 'windows',
      description: t('downloadZip'),
      url: `${DOWNLOAD_URL}/browser4agent-x86_64-pc-windows-msvc.zip`,
    },
    {
      name: 'macOS',
      type: 'macos',
      description: t('downloadTarGz'),
      url: `${DOWNLOAD_URL}/browser4agent-aarch64-apple-darwin.tar.gz`,
    },
    {
      name: 'Linux',
      type: 'linux',
      description: t('downloadTarGz'),
      url: `${DOWNLOAD_URL}/browser4agent-x86_64-unknown-linux-gnu.tar.gz`,
    },
  ];

  #helpLinks = [
    { label: t('viewDocs'), url: `${REPO_URL}#readme` },
    { label: t('faq'), url: `${REPO_URL}/issues?q=is%3Aissue` },
    // biome-ignore lint/style/useTemplate: build bug?
    { label: t('reportIssue'), url: REPO_URL + '/issues/new' },
  ];

  #flowItems = [
    {
      type: 'agent',
      title: 'AI Agent (MCP)',
      description: t('flowAgentDesc'),
    },
    {
      type: 'host',
      title: 'Native Host',
      description: t('flowHostDesc'),
    },
    {
      type: 'extension',
      title: t('browserExtensionTitle'),
      description: t('browserExtensionDesc'),
    },
  ];

  #renderPlatformIcon = (type) => {
    switch (type) {
      case 'windows':
        return html`
          <svg aria-hidden="true" class="size-11" viewBox="0 0 48 48">
            <path
              fill="currentColor"
              d="M4 10.2 21.5 7.7v15.5H4V10.2Zm19.6-2.8L44 4.5v18.7H23.6V7.4ZM4 25.2h17.5v15.6L4 38.4V25.2Zm19.6 0H44v18.3l-20.4-2.8V25.2Z"
            ></path>
          </svg>
        `;
      case 'macos':
        return html`
          <svg aria-hidden="true" class="size-11" viewBox="0 0 40 40">
            <path
              fill="currentColor"
              d="M25.6 8.1c2.2-2.7 2-5.1 1.9-6.1-1.9.1-4.2 1.3-5.5 2.9-1.2 1.4-2.2 3.6-1.9 5.7 2 .2 4.1-.9 5.5-2.5Zm7.1 20.1c-.7 1.6-1 2.3-1.9 3.8-1.2 2-2.9 4.5-5 4.5-1.9 0-2.4-1.3-5-1.3s-3.2 1.3-5.1 1.3c-2.1.1-3.7-2.2-4.9-4.2-3.4-5.6-3.8-12.1-1.7-15.6 1.5-2.5 3.8-4 6.1-4 2.4 0 3.9 1.3 5.8 1.3 1.9 0 3.1-1.3 5.9-1.3 2.1 0 4.4 1.2 5.9 3.2-5.2 2.9-4.4 10.4-.1 12.3Z"
            ></path>
          </svg>
        `;
      default:
        return html`
          <svg aria-hidden="true" class="size-11" viewBox="0 0 48 48">
            <path
              fill="currentColor"
              d="M24 4c-6.1 0-10 5.5-10 13.4 0 3.4-.8 5.7-2.2 8.4-1.2 2.2-2.5 4.7-2.5 8.7C9.3 40.7 14.4 44 24 44s14.7-3.3 14.7-9.5c0-4-1.3-6.5-2.5-8.7-1.4-2.7-2.2-5-2.2-8.4C34 9.5 30.1 4 24 4Zm-3.8 12.7c-1.2 0-2.2-1-2.2-2.3s1-2.3 2.2-2.3 2.2 1 2.2 2.3-1 2.3-2.2 2.3Zm7.6 0c-1.2 0-2.2-1-2.2-2.3s1-2.3 2.2-2.3 2.2 1 2.2 2.3-1 2.3-2.2 2.3Z"
            ></path>
            <path
              fill="white"
              d="M17.8 25.2c1.2-2.4 3.4-3.7 6.2-3.7s5 1.3 6.2 3.7c1.2 2.3 2.8 5.7 2.8 9 0 4-3.2 6.2-9 6.2s-9-2.2-9-6.2c0-3.3 1.6-6.7 2.8-9Z"
              opacity=".92"
            ></path>
            <path fill="currentColor" d="M20.7 26.7c1.5 1.3 5.1 1.3 6.6 0-.6 1.8-1.7 3-3.3 3s-2.7-1.2-3.3-3Z"></path>
          </svg>
        `;
    }
  };

  #renderFlowIcon = (type) => {
    switch (type) {
      case 'extension':
        return html`
          <svg aria-hidden="true" class="size-10" viewBox="0 0 48 48">
            <rect width="32" height="26" x="7" y="8" fill="currentColor" opacity=".28" rx="3"></rect>
            <path fill="currentColor" d="M7 15h32v-4a3 3 0 0 0-3-3H10a3 3 0 0 0-3 3v4Z"></path>
            <circle cx="13" cy="12" r="1.5" fill="white"></circle>
            <circle cx="18" cy="12" r="1.5" fill="white" opacity=".75"></circle>
            <path
              fill="currentColor"
              d="M31 25h2.5a3.5 3.5 0 1 1 0 7H31v6h-7v-2.3a3.7 3.7 0 1 0-7.4 0V38H10v-6h2.5a3.5 3.5 0 1 0 0-7H10v-6h7.2a3.8 3.8 0 1 1 7.6 0H31v6Z"
            ></path>
          </svg>
        `;
      case 'host':
        return html`
          <svg aria-hidden="true" class="size-10" viewBox="0 0 48 48">
            <rect width="34" height="28" x="7" y="9" fill="currentColor" opacity=".25" rx="5"></rect>
            <path
              fill="currentColor"
              d="M12 16.4 14.1 14l7.7 7.1-7.7 7.1L12 25.8l5.1-4.7L12 16.4ZM23 28h12v3H23v-3Z"
            ></path>
          </svg>
        `;
      default:
        return html`
          <svg aria-hidden="true" class="size-10" viewBox="0 0 48 48">
            <rect width="28" height="22" x="10" y="14" fill="currentColor" opacity=".25" rx="8"></rect>
            <path fill="currentColor" d="M22.5 9h3v5h-3V9ZM9 22H5v8h4v-8Zm34 0h-4v8h4v-8Z"></path>
            <path
              fill="currentColor"
              d="M18 23.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm12 0a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM19 32h10v2H19v-2Z"
            ></path>
          </svg>
        `;
    }
  };

  #renderStepHeader = (index, title, description) => html`
    <div class="flex items-start gap-4">
      <span
        class="grid size-10 shrink-0 place-items-center rounded-full bg-linear-to-br from-indigo-500 to-violet-600 text-lg font-bold text-white shadow-lg shadow-indigo-500/25"
      >
        ${index}
      </span>
      <div class="min-w-0">
        <h2 class="m-0 text-xl font-bold leading-7 text-highlight">${title}</h2>
        <p class="mb-0 mt-2 text-sm leading-6 text-text sm:text-base">${description}</p>
      </div>
    </div>
  `;

  #renderDownloadCard = (platform) => html`
    <a
      href=${platform.url}
      target="_blank"
      rel="noreferrer"
      class="group flex min-h-24 items-center gap-5 rounded-lg border border-border bg-white px-6 py-5 text-left no-underline shadow-sm transition hover:-translate-y-0.5 hover:border-primary hover:shadow-lg hover:shadow-indigo-500/10"
      aria-label=${t('downloadAria', platform.name)}
    >
      <span class="grid size-12 shrink-0 place-items-center text-slate-600 transition group-hover:text-primary">
        ${this.#renderPlatformIcon(platform.type)}
      </span>
      <span class="min-w-0">
        <strong class="block text-lg leading-6 text-highlight">${platform.name}</strong>
        <span class="mt-1 block text-sm text-describe">${platform.description}</span>
      </span>
    </a>
  `;

  #renderFlowItem = (item, index) => html`
    <div class="flex min-w-0 items-start gap-5 sm:flex-1">
      <div class="flex min-w-0 flex-1 flex-col items-center text-center">
        <span class="grid size-16 place-items-center rounded-lg bg-indigo-50 text-primary shadow-inner shadow-indigo-100">
          ${this.#renderFlowIcon(item.type)}
        </span>
        <strong class="mt-3 text-sm leading-5 text-highlight">${item.title}</strong>
        <span class="mt-1 text-xs leading-5 text-describe">${item.description}</span>
      </div>
      <span v-if=${index < this.#flowItems.length - 1} class="hidden h-16 shrink-0 items-center sm:flex">
        <dy-use class="text-4xl text-slate-300" .element=${icons.right}></dy-use>
      </span>
    </div>
  `;

  @template()
  #content = () => {
    const manifest = chrome.runtime.getManifest();
    const icon = chrome.runtime.getURL(manifest.icons['128']);

    return html`
      <main class="mx-auto flex w-full max-w-216 flex-col gap-8 px-5 py-10 sm:px-7 sm:py-16">
        <header class="text-center">
          <img
            src=${icon}
            class="mx-auto mb-7 size-28 rounded-[1.375rem] shadow-2xl shadow-indigo-500/20"
            alt="Browser for AI Agent"
          />
          <h1 class="m-0 text-3xl font-bold leading-tight text-highlight sm:text-[2.5rem]">
            ${t('welcomeTitle')}
          </h1>
          <p class="mx-auto mb-0 mt-4 max-w-2xl text-base leading-7 text-describe sm:text-lg">
            ${t('welcomeSubtitle')}
          </p>
        </header>

        <section class="overflow-hidden rounded-lg border border-border bg-white/90 shadow-2xl shadow-slate-200/70 backdrop-blur">
          <div class="p-7 sm:p-8">
            ${this.#renderStepHeader(
              '1',
              t('stepDownloadTitle'),
              html`
                ${t('stepDownloadDesc')}
                <dy-popover
                  position="bottomLeft"
                  .content=${html`<welcome-native-install-popover class="py-2"></welcome-native-install-popover>`}
                >
                  <span class="text-primary cursor-default">${t('packageInstallHint')}</span>
                </dy-popover>
              `,
            )}
            <div class="mt-6 grid gap-4 sm:grid-cols-3">${this.#platforms.map(this.#renderDownloadCard)}</div>
            <p class="mt-6 flex items-start gap-2 text-sm leading-6 text-describe">
              <dy-use class="mt-0.5 shrink-0 text-base" .element=${icons.info}></dy-use>
              <span>${t('nativeHostPrivacy')}</span>
            </p>
          </div>

          <div class="h-px bg-border"></div>

          <div class="p-7 sm:p-8">
            ${this.#renderStepHeader('2', t('stepInstallTitle'), t('stepInstallDesc'))}
            <div class="mt-6 rounded-lg border border-indigo-200 bg-indigo-50/80 p-6 sm:flex sm:items-start sm:gap-6">
              <span class="mb-5 grid size-16 shrink-0 place-items-center rounded-lg bg-white text-primary shadow-sm sm:mb-0">
                ${this.#renderFlowIcon('host')}
              </span>
              <div class="min-w-0">
                <h3 class="m-0 text-lg font-bold leading-6 text-highlight">${t('openOnce')}</h3>
                <p class="mb-0 mt-2 text-sm leading-6 text-text">${t('openOnceDesc')}</p>
                <ul class="m-0 mt-4 flex list-none flex-col gap-3 p-0 text-sm leading-6 text-highlight">
                  <li class="flex items-center gap-3">
                    <dy-use class="text-positive" .element=${icons.check}></dy-use>
                    <span>${t('configureNativeHost')}</span>
                  </li>
                  <li class="flex items-center gap-3">
                    <dy-use class="text-positive" .element=${icons.check}></dy-use>
                    <span>${t('configureMcp')}</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div class="h-px bg-border"></div>

          <div class="p-7 sm:p-8">
            ${this.#renderStepHeader('3', t('stepStartTitle'), t('stepStartDesc'))}
            <div class="mt-7 pl-0 sm:pl-14">
              <p class="m-0 text-lg font-bold leading-7 text-primary">${t('readyTitle')}</p>
              <p class="mb-0 mt-3 text-sm leading-6 text-text">${t('readyDesc')}</p>
            </div>
          </div>
        </section>

        <section class="rounded-lg border border-border bg-white/90 p-7 shadow-xl shadow-slate-200/60 sm:p-8">
          <h2 class="m-0 text-base font-bold text-highlight">${t('howItWorks')}</h2>
          <div class="mt-6 flex flex-col gap-5 sm:flex-row sm:items-center">
            ${this.#flowItems.map(this.#renderFlowItem)}
          </div>
        </section>

        <footer
          class="flex flex-col items-center justify-center gap-4 rounded-lg bg-indigo-50/80 px-5 py-4 text-sm text-text sm:flex-row sm:gap-10"
        >
          <span class="flex items-center gap-2">
            <dy-use class="text-describe" .element=${icons.help}></dy-use>
            <span>${t('needHelp')}</span>
          </span>
          <nav class="flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
            ${this.#helpLinks.map(
              (link) => html`
                <a
                  href=${link.url}
                  target="_blank"
                  rel="noreferrer"
                  class="inline-flex items-center gap-1.5 text-primary no-underline hover:underline"
                >
                  <span>${link.label}</span>
                  <dy-use class="text-xs" .element=${icons.outward}></dy-use>
                </a>
              `,
            )}
          </nav>
        </footer>
      </main>
    `;
  };
}
