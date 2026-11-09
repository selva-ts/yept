import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Same aliases as electron.vite.config.ts, including the shared modules and HTML formatter.
  resolve: {
    alias: {
      '@shared': resolve('packages/core/src/shared'),
      '@yept/core': resolve('packages/core/src'),
      '@yept/ui': resolve('packages/ui/src'),
      '@html-beautify': resolve('node_modules/monaco-editor/esm/external/vscode-html-languageservice/lib/esm/beautify/beautify-html.js')
    }
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 15000
  }
});
