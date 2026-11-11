// End-to-end: client certificates (mutual TLS). In the environment editor: a PFX added for a host with its passphrase,
// the passphrase encrypted on disk and never shown, a wrong passphrase explained, and the certificate removed. Sent to
// a local HTTPS server that requires a client certificate, Network shows the certificate's subject.
// Needs openssl (ships with Git for Windows) to make the test certificates; skipped without it.
// Usage: npm run build && node e2e/client-certs.mjs   (screenshots go to e2e/out/, which is git-ignored)
import { _electron as electron } from 'playwright';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  console.log('SKIP client certificates: openssl is not on PATH');
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e', 'out');
await fs.mkdir(out, { recursive: true });

const tmp = await fs.mkdtemp(join(tmpdir(), 'yept-e2e-'));
const wsDir = join(tmp, 'ws');
const userData = join(tmp, 'user-data');
const certs = join(tmp, 'certs');
await fs.cp(join(root, 'fixtures', 'collections'), wsDir, { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(certs, { recursive: true });
await fs.writeFile(join(userData, 'preferences.json'), JSON.stringify({ lastWorkspace: wsDir }));

// A throwaway CA, a server certificate for 127.0.0.1 and a client certificate in a PFX with a passphrase.
const PASSPHRASE = 'sample-pfx-passphrase';
const f = (n) => join(certs, n);
const ssl = (...args) => void execFileSync('openssl', args, { stdio: 'ignore' });
ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', '1', '-subj', '/CN=Yept E2E mTLS CA');
for (const [name, subject, ext] of [['server', '/CN=127.0.0.1', 'subjectAltName=IP:127.0.0.1'], ['client', '/CN=sample-client/O=Yept Tests', 'extendedKeyUsage=clientAuth']]) {
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f(`${name}.key`), '-out', f(`${name}.csr`), '-subj', subject);
  writeFileSync(f(`${name}.cnf`), `${ext}\n`);
  ssl('x509', '-req', '-in', f(`${name}.csr`), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f(`${name}.pem`), '-days', '1', '-extfile', f(`${name}.cnf`));
}
ssl('pkcs12', '-export', '-in', f('client.pem'), '-inkey', f('client.key'), '-out', f('client.pfx'), '-passout', `pass:${PASSPHRASE}`, '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg', 'sha256');

const server = https.createServer({ key: readFileSync(f('server.key')), cert: readFileSync(f('server.pem')), ca: readFileSync(f('ca.pem')), requestCert: true, rejectUnauthorized: true }, (req, res) => {
  res.end(`client ${req.socket.getPeerCertificate()?.subject?.CN ?? 'none'}`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
// Antivirus TLS inspection (e.g. Norton Web Shield) re-signs even loopback connections and can't pass a client
// certificate on, so the sending checks need a machine without it (CI has none).
const intercepted = await new Promise((resolveIssuer) => {
  const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, cert: readFileSync(f('client.pem')), key: readFileSync(f('client.key')) }, () => {
    resolveIssuer(String(s.getPeerCertificate().issuer?.CN ?? ''));
    s.end();
  });
  s.setTimeout(5000, () => { s.destroy(); resolveIssuer('a TLS inspector that holds the connection'); });
  s.on('error', () => resolveIssuer(''));
}).then((issuer) => (issuer && issuer !== 'Yept E2E mTLS CA' ? issuer : ''));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ args: [root], env: { ...process.env, YEPT_USER_DATA: userData } });
const page = await app.firstWindow();
page.on('pageerror', (e) => check('no renderer errors', false, e.message));
await page.setViewportSize({ width: 1400, height: 900 });
const shot = (name) => page.screenshot({ path: join(out, `client-certs-${name}.png`) });
const stubOpen = (files) => app.evaluate(({ dialog }, fl) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: fl }); }, files);
const dlg = () => page.getByRole('dialog', { name: 'Environments' });
const openEnvEditor = async () => {
  await page.locator('.tree-row.collection', { hasText: 'Sample Travel' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Environments…' }).click();
  await dlg().waitFor();
};
const closeEnvEditor = () => dlg().getByRole('button', { name: 'Close' }).click();
const localFile = () => fs.readFile(join(userData, 'local-environments.json'), 'utf8');
async function send() {
  await page.keyboard.press('Control+Enter');
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
}

try {
  await page.getByText('Sample Travel').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Open Sample Travel' }).click();
  await page.getByRole('button', { name: '+ New request' }).click();
  await page.getByRole('dialog').locator('input').fill('Mutual TLS');
  await page.keyboard.press('Enter');
  await page.locator('.doc-title', { hasText: 'Mutual TLS' }).waitFor();
  await page.getByLabel('URL', { exact: true }).fill(`https://127.0.0.1:${port}/`);

  // 1. The local environment trusts the test CA and gets the PFX for 127.0.0.1.
  await openEnvEditor();
  await dlg().getByRole('button', { name: 'Use this environment' }).click();
  await stubOpen([f('ca.pem')]);
  await dlg().getByRole('button', { name: 'Browse…' }).click();
  await dlg().locator('input[readonly]', { hasText: '' }).first().waitFor();
  await dlg().getByRole('button', { name: '+ Add client certificate' }).click();
  await dlg().getByLabel('Certificate host').fill('127.0.0.1');
  await stubOpen([f('client.pfx')]);
  await dlg().getByRole('button', { name: 'Choose…' }).click();
  await dlg().getByText('client.pfx').waitFor();
  check('a PFX needs no separate key', (await dlg().getByRole('button', { name: 'Choose key…' }).count()) === 0);
  await dlg().getByLabel('Certificate passphrase').fill(PASSPHRASE);
  await shot('01-adding');
  await dlg().getByRole('button', { name: 'Add certificate' }).click();
  const row = dlg().getByRole('table', { name: 'Client certificates' }).locator('tr', { hasText: '127.0.0.1' });
  await row.waitFor();
  check('the certificate is listed with its file', (await row.innerText()).includes('client.pfx'));
  check('the passphrase shows as stored, not filled in', (await dlg().getByLabel('Passphrase for 127.0.0.1').getAttribute('placeholder'))?.includes('stored') && (await dlg().getByLabel('Passphrase for 127.0.0.1').inputValue()) === '');
  const stored = await localFile();
  check('local settings keep the path, and the passphrase encrypted', stored.includes('client.pfx') && !stored.includes(PASSPHRASE) && stored.includes('certPassphrases'));
  check('the passphrase never reaches the page', !(await page.content()).includes(PASSPHRASE));
  await shot('02-listed');
  await closeEnvEditor();

  // 2. Sent to a server that requires a client certificate.
  if (intercepted) {
    console.log(`SKIP sending checks: TLS on this machine is intercepted by "${intercepted}"`);
  } else {
    await send();
    await page.locator('.response', { hasText: 'client sample-client' }).waitFor({ timeout: 10000 });
    check('the server got the client certificate', true);
    await page.keyboard.press('Control+Shift+J');
    await page.locator('section.devtools').getByRole('tab', { name: /^Network/ }).click();
    await page.locator('.dt-network tbody tr', { hasText: '127.0.0.1' }).first().click();
    await page.locator('.dt-details').getByRole('tab', { name: 'Connection' }).click();
    const conn = await page.locator('.dt-details .headers-list').innerText();
    check('Network shows the client certificate subject', /Client certificate\s+CN=sample-client, O=Yept Tests/.test(conn), conn.split('\n').find((l) => l.startsWith('Client')));
    await shot('03-network');
    await page.keyboard.press('Control+Shift+J');
  }

  // 3. A wrong passphrase stops the send with an explanation.
  await openEnvEditor();
  await dlg().getByLabel('Passphrase for 127.0.0.1').fill('not-the-passphrase');
  await dlg().getByLabel('Passphrase for 127.0.0.1').press('Enter');
  await page.waitForTimeout(300);
  await closeEnvEditor();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const toast = page.locator('.toast.error', { hasText: 'client certificate for 127.0.0.1' });
  await toast.first().waitFor({ timeout: 10000 }).catch(async () => console.log('toasts:', await page.locator('.toast').allInnerTexts()));
  const said = (await toast.count()) ? await toast.first().innerText() : '';
  check('a wrong passphrase is explained', said.includes('the passphrase is wrong'), said);

  // 4. Removing the certificate drops its passphrase too.
  await openEnvEditor();
  await dlg().getByRole('button', { name: 'Remove the certificate for 127.0.0.1' }).click();
  await dlg().getByRole('button', { name: '+ Add client certificate' }).waitFor();
  check('the certificate is removed', (await dlg().getByRole('table', { name: 'Client certificates' }).count()) === 0);
  const after = await localFile();
  check('its passphrase is removed with it', !after.includes('client.pfx') && !/"certPassphrases": \{\s*"/.test(after));
  await closeEnvEditor();
  if (!intercepted) {
    await send();
    await page.locator('.response', { hasText: /requires a client certificate|didn't accept the client certificate/ }).waitFor({ timeout: 10000 });
    check('without it the server refuses, in plain words', true);
  }
} catch (e) {
  check('scenario completed', false, e.message.split('\n')[0]);
  await shot('99-failure').catch(() => {});
} finally {
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  server.closeAllConnections();
  server.close();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
