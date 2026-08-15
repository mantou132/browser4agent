/** @type {import('extension').FileConfig} */

const profile = (name) => `./dist/extension-profile-${name}`;

export default {
  commands: {
    dev: {
      browser: 'chrome',
      startingUrl: 'https://example.com',
      profile: profile('chrome'),
    },
    build: {
      browser: 'chrome,firefox',
      zip: true,
    },
  },
  config(config) {
    config.target = ['web', 'es2024'];
    config.module ??= {};
    config.module.rules ??= [];
    config.module.rules.unshift({
      test: /\.js$/,
      enforce: 'pre',
      include: (filename) => !filename.includes('node_modules'),
      use: [
        {
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              target: 'es2024',
              parser: { syntax: 'typescript', decorators: true, explicitResourceManagement: true },
              transform: { decoratorVersion: '2023-11' },
              externalHelpers: true,
              experimental: {
                // runPluginFirst: true,
                plugins: [
                  [
                    'swc-plugin-gem',
                    {
                      styleMinify: true,
                      // hmr: true,
                      selectorCompatible: true,
                      autoImport: {
                        extends: 'gem',
                        elements: {
                          '@': {
                            'options-*': '/options/elements/*',
                            'popup-*': '/popup/elements/*',
                            'market-*': '/pages/elements/*',
                            'welcome-*': '/pages/elements/*',
                            'agent-*': '/pages/elements/*',
                          },
                        },
                      },
                      autoImportDts: 'auto-import.d.ts',
                    },
                  ],
                ],
              },
            },
          },
        },
      ],
    });
    return config;
  },
};
