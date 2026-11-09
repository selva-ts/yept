// Draws the app icon files from build/yept-icon.svg: yept-icon.png (512 px, window icon),
// yept-icon-1024.png (macOS) and yept-icon.ico (16-256 px, Windows exe, installer and shortcuts).
// The .ico's 16-32 px images come from build/yept-icon-small.svg (wider Y, larger arrow) so they stay legible.
// Runs in Electron so Chromium does the drawing; no other tools needed: npm run icons
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dir = join(__dirname, '../../../../build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SMALL_MAX = 32;

// An .ico of PNG images, one directory entry per size.
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const svg = readFileSync(join(dir, 'yept-icon.svg'), 'utf8');
  const smallSvg = readFileSync(join(dir, 'yept-icon-small.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  const render = async (size, source = svg) => {
    const url = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(`data:image/svg+xml,${encodeURIComponent(source)}`)};
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, ${size}, ${size});
      return c.toDataURL('image/png');
    })()`);
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  };
  writeFileSync(join(dir, 'yept-icon.png'), await render(512));
  writeFileSync(join(dir, 'yept-icon-1024.png'), await render(1024));
  const pngs = [];
  for (const size of ICO_SIZES) pngs.push({ size, data: await render(size, size <= SMALL_MAX ? smallSvg : svg) });
  writeFileSync(join(dir, 'yept-icon.ico'), ico(pngs));
  console.log(`Wrote yept-icon.png, yept-icon-1024.png and yept-icon.ico (${ICO_SIZES.join(', ')} px)`);
  app.quit();
});
