// Formats HTML/XML off the UI thread: a body near the 50 MB processing limit takes seconds.
import { formatMarkup, type MarkupKind } from './markup';

self.onmessage = (e: MessageEvent<{ text: string; kind: MarkupKind }>) => {
  try {
    self.postMessage({ ok: true, text: formatMarkup(e.data.text, e.data.kind) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
