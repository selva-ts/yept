import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// The HTML formatter that monaco-editor bundles (js-beautify, MIT); the package's exports map doesn't expose it.
const htmlBeautify = resolve('node_modules/monaco-editor/esm/external/vscode-html-languageservice/lib/esm/beautify/beautify-html.js');
const alias = {
  '@shared': resolve('packages/core/src/shared'),
  '@yept/core': resolve('packages/core/src'),
  '@yept/ui': resolve('packages/ui/src')
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { input: resolve('apps/desktop/src/host/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { input: resolve('apps/desktop/src/host/preload/index.ts') } }
  },
  renderer: {
    root: resolve('apps/desktop/src/renderer'),
    plugins: [react()],
    resolve: { alias: { ...alias, '@html-beautify': htmlBeautify } },
    build: { rollupOptions: { input: resolve('apps/desktop/src/renderer/index.html') } }
  }
});
