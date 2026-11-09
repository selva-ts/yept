// Waits for a file the app writes in the background, instead of sleeping for a fixed time that slow machines can miss.
import { readFileSync } from 'node:fs';

/** The file's contents once `ready` accepts them, or its last contents ('' if it is missing) after `timeout` ms. */
export async function waitForFile(path, ready, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (ready(text) || Date.now() >= deadline) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
