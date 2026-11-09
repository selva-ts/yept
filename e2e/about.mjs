// End-to-end: About and the third-party notice view, in the development or packaged app.
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'));
const tmp = await fs.mkdtemp(join(tmpdir(), 'yept-e2e-'));
const workspace = join(tmp, 'collections');
const userData = join(tmp, 'user-data');
await fs.cp(join(root, 'fixtures', 'collections'), workspace, { recursive: true });
await fs.mkdir(userData);
await fs.writeFile(join(userData, 'preferences.json'), JSON.stringify({ lastWorkspace: workspace }));

let app;
try {
  const packaged = process.env.YEPT_PACKAGED_EXE;
  app = await electron.launch({ ...(packaged ? { executablePath: packaged, args: [] } : { args: [root] }), env: { ...process.env, YEPT_USER_DATA: userData } });
  const page = await app.firstWindow();
  await page.getByText('Sample Travel').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'About Yept and third-party notices…' }).click();
  const dialog = page.getByRole('dialog', { name: 'About Yept' });
  await dialog.getByText(`Yept ${version}`, { exact: false }).waitFor();
  await dialog.getByText('@usebruno/filestore@0.13.0', { exact: false }).waitFor();
  await dialog.getByText('Yept third-party notices', { exact: false }).waitFor();
  console.log('PASS About shows packaged version and third-party notices');
} finally {
  await app?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
