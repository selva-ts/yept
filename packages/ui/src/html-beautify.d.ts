// js-beautify's HTML beautifier as bundled in monaco-editor; aliased in electron.vite.config.ts and vitest.config.ts.
declare module '@html-beautify' {
  export interface HTMLBeautifyOptions {
    indent_size?: number;
    wrap_line_length?: number;
    preserve_newlines?: boolean;
    end_with_newline?: boolean;
    extra_liners?: string[];
    inline?: string[];
    void_elements?: string[];
    unformatted?: string[];
    content_unformatted?: string[];
  }
  export function html_beautify(source: string, options?: HTMLBeautifyOptions): string;
}
