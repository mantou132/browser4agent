import { CopyRspackPlugin } from '@rspack/core';

export default {
  commands: {
    dev: {
      browser: 'chrome',
      startingUrl: 'https://example.com',
      persistProfile: true,
      preferences: { darkMode: false },
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
              transform: { decoratorVersion: '2022-03' },
              externalHelpers: true,
              experimental: {
                runPluginFirst: true,
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
                          extension: {
                            'options-*': '/options/elements/*',
                            'popup-*': '/popup/elements/*',
                          },
                        },
                      },
                      autoImportDts: 'extension/auto-import.d.ts',
                    },
                  ],
                ],
              },
            },
          },
        },
      ],
    });
    config.plugins ??= [];
    config.plugins.push(
      new CopyRspackPlugin({
        patterns: [
          { from: `./extension/toolsets`, to: 'toolsets' },
          { from: `./extension/serialize.js`, to: 'serialize.js' },
        ],
      }),
    );
    return config;
  },
};
