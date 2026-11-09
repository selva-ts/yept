import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [{ name: 'inline-webview-workers', enforce: 'pre', transform(code, id) {
    if (!id.includes('/packages/ui/')) return;
    return code.replace(/\?worker(['"])/g, '?worker&inline$1');
  } }, { name: 'drop-fallback-workers', generateBundle: { order: 'post', handler(_options, bundle) {
    // Monaco's language modes emit their own worker files as a fallback; the page always supplies the inlined workers.
    for (const file of Object.keys(bundle)) if (/^assets\/\w+\.worker-[\w-]+\.js$/.test(file)) delete bundle[file];
  } } }],
  esbuild: { jsx: 'automatic' },
  // The shared UI imports the core shared modules through this alias, as in the desktop renderer.
  resolve: { alias: { '@html-beautify': fileURLToPath(new URL('../../node_modules/monaco-editor/esm/external/vscode-html-languageservice/lib/esm/beautify/beautify-html.js', import.meta.url)), '@shared': fileURLToPath(new URL('../../packages/core/src/shared', import.meta.url)) } },
  build: {
    outDir: 'dist/webview',
    emptyOutDir: true,
    lib: {
      entry: { main: fileURLToPath(new URL('./src/webview/main.ts', import.meta.url)), runner: fileURLToPath(new URL('./src/webview/runner.ts', import.meta.url)), devtools: fileURLToPath(new URL('./src/webview/devtools.ts', import.meta.url)), diagnostics: fileURLToPath(new URL('./src/webview/diagnostics.ts', import.meta.url)) },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
      cssFileName: 'main'
    }
  }
});
