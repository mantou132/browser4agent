import { fileURLToPath } from 'node:url';
import { CopyRspackPlugin } from '@rspack/core';

const extensionRoot = fileURLToPath(new URL('./extension/', import.meta.url)).replaceAll('\\', '/');

export default {
  config(config) {
    config.target = ['web', 'es2024'];
    config.module ??= {};
    config.module.rules ??= [];
    config.module.rules.unshift({
      test: /\.js$/,
      enforce: 'pre',
      include: (filename) => filename.replaceAll('\\', '/').startsWith(extensionRoot),
      use: [
        {
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              target: 'es2024',
              parser: {
                syntax: 'ecmascript',
                decorators: true,
                explicitResourceManagement: true,
              },
              transform: { decoratorVersion: '2022-03' },
            },
          },
        },
      ],
    });
    config.plugins ??= [];
    config.plugins.push(
      new CopyRspackPlugin({
        patterns: [{ from: `${extensionRoot}toolsets`, to: 'toolsets' }],
      }),
    );
    return config;
  },
};
