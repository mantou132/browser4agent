@customElement('mcp-welcome-page')
class McpWelcomePageElement extends GemElement {
  #platforms = [
    {
      name: 'macOS',
      icon: '🍎',
      url: 'https://github.com/nicepkg/browser4agent/releases/latest/download/browser4agent-darwin-arm64',
    },
    {
      name: 'Linux',
      icon: '🐧',
      url: 'https://github.com/nicepkg/browser4agent/releases/latest/download/browser4agent-linux-x64',
    },
    {
      name: 'Windows',
      icon: '🪟',
      url: 'https://github.com/nicepkg/browser4agent/releases/latest/download/browser4agent-windows-x64.exe',
    },
  ];

  #openOptions = () => {
    chrome.runtime.openOptionsPage();
  };

  @template()
  #content = () => {
    const manifest = chrome.runtime.getManifest();
    const icon = chrome.runtime.getURL(manifest.icons['128']);
    return html`
      <div class="max-w-100 mx-auto pt-20 pb-16 px-7 text-center">
        <img src=${icon} class="w-20 h-20 mx-auto mb-6" />
        <h1 class="text-2xl m-0 mb-2 text-highlight">欢迎使用 Browser for AI Agent</h1>
        <p class="m-0 mb-8 text-describe text-sm">让 AI Agent 读取浏览器标签页内容、操控浏览器</p>

        <dy-divider class="mb-8"></dy-divider>

        <h2 class="text-base m-0 mb-2 text-highlight">下载 Native Host</h2>
        <p class="m-0 mb-5 text-describe text-sm">按你的平台下载并打开一次，将自动配置 Native Messaging Host 和 AI Agent MCP</p>

        <div class="flex justify-center gap-4 mb-8">
          ${this.#platforms.map(
            (p) => html`
              <a
                href=${p.url}
                target="_blank"
                class="flex flex-col items-center gap-2 py-4 px-6 border border-border rounded-xl hover:border-primary transition-[border-color] no-underline"
              >
                <span class="text-3xl">${p.icon}</span>
                <span class="text-sm font-semibold text-highlight">${p.name}</span>
              </a>
            `,
          )}
        </div>

        <dy-button @click=${this.#openOptions}>进入设置</dy-button>
      </div>
    `;
  };
}
