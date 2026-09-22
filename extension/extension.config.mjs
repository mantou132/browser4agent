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
    config.target = ['web', 'es2024', 'browserslist:chrome >= 125, firefox >= 128'];
    config.module ??= {};
    config.module.rules ??= [];
    // sandbox-globals 会被 Function.toString() 注入 QuickJS 按原文执行，必须排除转译：
    // 转译产物的 helper 引用模块作用域变量，进 VM 就会报 undefined
    config.module.rules.unshift({
      test: /\.js$/,
      enforce: 'pre',
      include: (filename) => !filename.includes('node_modules') && !/[\\/]sandbox-globals\.js$/.test(filename),
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
                plugins: [
                  [
                    'swc-plugin-gem',
                    {
                      styleMinify: true,
                      selectorCompatible: true,
                      autoImport: {
                        extends: 'gem',
                        elements: {
                          '@': {
                            'options-*': '/options/elements/*',
                            'popup-*': '/popup/elements/*',
                            'market-*': '/pages/elements/*',
                            'welcome-*': '/pages/elements/*',
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
