// pdfjs-dist loads @napi-rs/canvas only when it runs under Node. Yept never does that.
throw new Error('@napi-rs/canvas is not available in Yept');
