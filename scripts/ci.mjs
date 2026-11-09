import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function releaseTag({ event, approved, ref, version, sha }) {
  if (event !== 'workflow_dispatch' || approved !== 'true') throw new Error('An explicit manual build approval is required');
  if (typeof version !== 'string' || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('A stable package version is required');
  if (ref !== `refs/tags/v${version}`) throw new Error('Select the version tag matching package.json, not a branch');
  if (typeof sha !== 'string' || sha.length !== 40 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('A commit SHA is required');
  return `v${version}`;
}

export async function verifyRelease(cwd, env) {
  const { version } = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
  const tag = releaseTag({ event: env.GITHUB_EVENT_NAME, approved: env.RELEASE_APPROVED, ref: env.GITHUB_REF, version, sha: env.GITHUB_SHA });
  const options = { cwd, windowsHide: true, timeout: 10000 };
  const { stdout } = await execute('git', ['rev-parse', '--verify', `${env.GITHUB_REF}^{commit}`], options);
  if (stdout.trim() !== env.GITHUB_SHA) throw new Error('The selected tag does not match the checked-out commit');
  const { stdout: head } = await execute('git', ['rev-parse', 'HEAD'], options);
  if (head.trim() !== env.GITHUB_SHA) throw new Error('The checked-out commit does not match the workflow commit');
  try { await execute('git', ['merge-base', '--is-ancestor', env.GITHUB_SHA, 'refs/remotes/origin/main'], options); }
  catch { throw new Error('The tagged commit must already be on origin/main'); }
  return tag;
}

export function selfTestCount(text, exitCode) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (exitCode !== 0 || !lines.length || lines.some(line => !line.startsWith('PASS '))) throw new Error('Packaged self-tests failed or returned no complete results');
  return lines.length;
}

async function runLogged(command, args, cwd, env, log, timeout = 120000) {
  try {
    const { stdout, stderr } = await execute(command, args, { cwd, env, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(log, stdout + stderr);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  } catch (error) {
    await writeFile(log, `${error.stdout ?? ''}${error.stderr ?? ''}\n${error.message}\nExit code: ${error.code ?? 'none'}, signal: ${error.signal ?? 'none'}\n`);
    throw error;
  }
}

export async function checkFixture(cwd, certificate) {
  if (process.platform !== 'win32') throw new Error('Windows fixture checks require Windows');
  const logs = resolve(cwd, 'out/ci');
  await mkdir(logs, { recursive: true });
  const server = spawn('dotnet', ['samples/SampleApi/bin/Debug/net10.0/SampleApi.dll', '--urls', 'https://localhost:7443'], {
    cwd, windowsHide: true, env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let startupError;
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  server.on('error', error => { startupError = error; });
  const stopped = new Promise(resolve => server.once('close', resolve));
  try {
    let ready = false;
    let failure;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (startupError) throw startupError;
      if (server.exitCode !== null) throw new Error(`HTTPS fixture exited with code ${server.exitCode}: ${output}`);
      try {
        const response = await fetch('https://localhost:7443/weatherforecast', { signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error(`HTTPS fixture returned ${response.status}`);
        await response.arrayBuffer();
        ready = true;
        break;
      } catch (error) { failure = error; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('Node could not reach the trusted HTTPS fixture', { cause: failure });
    const binary = (await readFile(resolve(cwd, 'node_modules/electron/path.txt'), 'utf8')).trim();
    const electron = resolve(cwd, 'node_modules/electron/dist', binary);
    const probe = `
      import https from 'node:https';
      import tls from 'node:tls';
      import { X509Certificate } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import { caOptions } from ${JSON.stringify(pathToFileURL(resolve(cwd, 'packages/core/src/engine/net/ca.ts')).href)};
      const options = caOptions();
      console.log('Electron HTTPS fixture check', { node: process.versions.node, electron: process.versions.electron, anchors: options.ca.length, systemCertificates: tls.getCACertificates('system').length });
      const file = ${JSON.stringify(certificate ? resolve(certificate) : null)};
      if (file) {
        const fixture = new X509Certificate(readFileSync(file));
        const included = options.ca.some(pem => new X509Certificate(pem).fingerprint256 === fixture.fingerprint256);
        console.log('Exported fixture certificate:', { fingerprint: fixture.fingerprint256, included });
        if (!included) throw new Error('The fixture certificate is missing from the trusted anchors');
      }
      const request = https.get('https://localhost:7443/weatherforecast', { ...options, timeout: 10000 }, response => {
        console.log('HTTPS fixture status:', response.statusCode);
        console.log('Served fixture certificate:', response.socket.getPeerCertificate().fingerprint256);
        response.resume();
        response.on('end', () => { process.exitCode = response.statusCode === 200 ? 0 : 1; });
      });
      request.on('timeout', () => request.destroy(new Error('HTTPS fixture timed out')));
      request.on('error', error => { console.error(error); process.exitCode = 1; });
    `;
    await runLogged(electron, ['--experimental-strip-types', '--input-type=module', '-e', probe], cwd, { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, resolve(logs, 'fixture-electron.log'));
  } finally {
    server.kill();
    await stopped;
    await writeFile(resolve(logs, 'fixture-server.log'), output);
  }
}

// Keep Electron's output on our pipes: by default it attaches to a parent console, which CI never shows.
const STARTUP_LOGGING = { args: ['--enable-logging=stderr'], env: { ELECTRON_ENABLE_LOGGING: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' } };

export function minimalEnvironment(env, userData) {
  const names = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'];
  const result = {};
  for (const name of names) {
    const value = name === 'PATH' ? env.PATH ?? env.Path : env[name];
    if (value !== undefined) result[name] = value;
  }
  return { ...result, YEPT_USER_DATA: userData };
}

export function variantSummary(name, { code, signal, ms, error }, progress, results) {
  const lines = progress.trim().split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1)?.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '');
  const status = error ? `launch error ${JSON.stringify(error)}` : signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
  const steps = lines.length ? `${lines.length} progress lines, last ${JSON.stringify(last)}` : 'no progress';
  const passed = results.split(/\r?\n/).filter(line => line.startsWith('PASS ')).length;
  return `${name}: ${status} after ${ms} ms; ${steps}; ${results.trim() ? `${passed} PASS` : 'no results'}`;
}

function waitForExit(child, timeout) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    let error;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('error', cause => { error = cause.message; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ...(error ? { error } : {}) });
    });
  });
}

async function runVariant(executable, cwd, { env, stdio, windowsHide }, timeout = 60000) {
  const started = performance.now();
  let output = '';
  try {
    const child = spawn(executable, ['--self-test', ...STARTUP_LOGGING.args], { cwd, env, stdio, windowsHide });
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { output += chunk; });
    const result = await waitForExit(child, timeout);
    return { ...result, ms: Math.round(performance.now() - started), output };
  } catch (error) {
    return { code: null, signal: null, ms: Math.round(performance.now() - started), error: error.message, output };
  }
}

async function playwrightVariant(executable, env) {
  const started = performance.now();
  let app;
  let output = '';
  let result;
  try {
    const { _electron } = await import('playwright');
    app = await _electron.launch({ executablePath: executable, args: ['--self-test', ...STARTUP_LOGGING.args], env, timeout: 60000 });
    const child = app.process();
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { output += chunk; });
    result = await waitForExit(child, 60000);
  } catch (error) {
    result = { code: null, signal: null, error: error.message };
  } finally {
    if (app) {
      let timer;
      try {
        await Promise.race([app.close(), new Promise(resolve => {
          timer = setTimeout(() => {
            try { app.process().kill('SIGKILL'); } catch {}
            resolve();
          }, 5000);
        })]);
      } catch {} finally { clearTimeout(timer); }
    }
  }
  return { ...result, ms: Math.round(performance.now() - started), output };
}

async function launchVariants(cwd, executable, profile, logs) {
  const names = Object.keys(process.env).sort().join(', ');
  await writeFile(resolve(logs, 'packaged-env-names.log'), names + '\n');
  console.log(`Packaged environment variable names: ${names}`);
  for (const name of ['playwright', 'visible', 'no-stdin', 'minimal-env']) {
    const folder = resolve(profile, 'variant-' + name);
    await mkdir(folder);
    const env = name === 'minimal-env' ? minimalEnvironment(process.env, folder) : { ...process.env, ...STARTUP_LOGGING.env, YEPT_USER_DATA: folder };
    const options = { env, stdio: [name === 'no-stdin' ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: name !== 'visible' };
    const launch = { launcher: name === 'playwright' ? 'playwright' : 'spawn', args: ['--self-test', ...STARTUP_LOGGING.args], timeout: 60000,
      ...(name === 'playwright' ? {} : { stdio: options.stdio, windowsHide: options.windowsHide }), environmentNames: Object.keys(env).sort() };
    let result;
    if (name === 'playwright') {
      const started = performance.now();
      const report = resolve(folder, 'launch.json');
      let output = '';
      let failure;
      // Isolate the launcher too: an unhandled Playwright rejection must not stop the other diagnostics.
      try {
        const { stdout, stderr } = await execute(process.execPath, [fileURLToPath(import.meta.url), 'playwright-variant', executable, report], {
          cwd, env, windowsHide: true, timeout: 130000, maxBuffer: 8 * 1024 * 1024
        });
        output = stdout + stderr;
      } catch (error) {
        failure = `Playwright launcher exited with code ${error.code ?? 'none'}, signal ${error.signal ?? 'none'}`;
        output = (error.stdout ?? '') + (error.stderr ?? '');
      }
      result = await readFile(report, 'utf8').then(JSON.parse).catch(() => ({ code: null, signal: null, error: 'Playwright launcher returned no report' }));
      result = { ...result, ...(failure ? { error: failure } : {}), ms: Math.round(performance.now() - started), output: (result.output ?? '') + output };
    } else result = await runVariant(executable, cwd, options);
    const progress = await readFile(resolve(folder, 'selftest-progress.txt'), 'utf8').catch(() => '');
    const results = await readFile(resolve(folder, 'selftest.txt'), 'utf8').catch(() => '');
    const summary = variantSummary(name, result, progress, results);
    await writeFile(resolve(logs, `variant-${name}.log`), `Launch options: ${JSON.stringify(launch, null, 2)}\n${summary}\nExit code: ${result.code ?? 'none'}, signal: ${result.signal ?? 'none'}\nProcess output:\n${result.output}\nProgress:\n${progress || 'No progress was recorded.\n'}Results:\n${results || 'No results were written.\n'}`);
    console.log(summary);
  }
}

/** Evidence for a packaged app that exits before it reports: Windows' own errors, and the same app on the stock Electron binary. */
async function diagnoseStartup(cwd, executable, profile, logs) {
  const events = "Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 1, 2, 3; StartTime = (Get-Date).AddMinutes(-30) } -MaxEvents 30 -ErrorAction SilentlyContinue | Format-List TimeCreated, ProviderName, Id, Message";
  await runLogged('powershell', ['-NoProfile', '-NonInteractive', '-Command', events], cwd, process.env, resolve(logs, 'packaged-events.log')).catch(() => {});
  await mkdir(profile, { recursive: true });
  const binary = (await readFile(resolve(cwd, 'node_modules/electron/path.txt'), 'utf8')).trim();
  const app = resolve(dirname(executable), 'resources/app.asar');
  await runLogged(resolve(cwd, 'node_modules/electron/dist', binary), [app, '--self-test', ...STARTUP_LOGGING.args], cwd, { ...process.env, ...STARTUP_LOGGING.env, YEPT_USER_DATA: profile }, resolve(logs, 'stock-electron-process.log'), 30000).catch(() => {});
  const text = await readFile(resolve(profile, 'selftest.txt'), 'utf8').catch(() => 'No results were written.\n');
  await writeFile(resolve(logs, 'stock-electron-selftest.log'), text);
  console.log(`Packaged app on the stock Electron binary:\n${text}`);
  await reportProgress(profile, 'Stock Electron binary', resolve(logs, 'stock-electron-progress.log'));
}

/** The app's own record of how far a self-test run got. */
async function reportProgress(profile, label, log) {
  const text = await readFile(resolve(profile, 'selftest-progress.txt'), 'utf8').catch(() => 'No progress was recorded.\n');
  await writeFile(log, text);
  console.log(`${label} self-test progress:\n${text}`);
}

export async function checkPackage(cwd) {
  if (process.platform !== 'win32') throw new Error('Windows package checks require Windows');
  const { load } = await import('js-yaml');
  const builder = load(await readFile(resolve(cwd, 'electron-builder.yml'), 'utf8'));
  const executable = resolve(cwd, 'dist/win-unpacked', `${builder.productName}.exe`);
  const logs = resolve(cwd, 'out/ci');
  await mkdir(logs, { recursive: true });
  const tempRoot = await realpath(tmpdir());
  const profile = await mkdtemp(resolve(tempRoot, 'yept-ci-'));
  try {
    let failure;
    const started = performance.now();
    // Electron and Chromium logging go to stderr, so start-up failures are recorded too.
    try { await runLogged(executable, ['--self-test', ...STARTUP_LOGGING.args], cwd, { ...process.env, ...STARTUP_LOGGING.env, YEPT_USER_DATA: profile }, resolve(logs, 'packaged-process.log')); }
    catch (error) { failure = error; }
    console.log(`Packaged self-test process finished after ${Math.round(performance.now() - started)} ms`);
    const text = await readFile(resolve(profile, 'selftest.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    await writeFile(resolve(logs, 'packaged-selftest.log'), text);
    if (failure) {
      // Keep the profile listing, including any crash dumps, for diagnosis.
      const files = await readdir(profile, { recursive: true }).catch(error => [`Cannot list the profile: ${error.message}`]);
      await writeFile(resolve(logs, 'packaged-profile.log'), files.join('\n') + '\n');
      await reportProgress(profile, 'Packaged app', resolve(logs, 'packaged-progress.log'));
      await diagnoseStartup(cwd, executable, resolve(profile, 'stock-electron'), logs).catch(error => console.log(`Start-up diagnostics failed: ${error.message}`));
      await launchVariants(cwd, executable, profile, logs).catch(error => console.log(`Launch-variant diagnostics failed: ${error.message}`));
      throw failure;
    }
    const count = selfTestCount(text, 0);
    process.stdout.write(text);
    console.log(`${count}/${count} packaged self-tests passed`);
    await runLogged(process.execPath, ['e2e/about.mjs'], cwd, { ...process.env, YEPT_PACKAGED_EXE: executable }, resolve(logs, 'packaged-about.log'));
  } finally {
    const path = relative(tempRoot, await realpath(profile));
    if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error('Unexpected self-test profile path');
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'release') {
    const tag = await verifyRelease(root, process.env);
    console.log(`Approved tag verified: ${tag} at ${process.env.GITHUB_SHA}`);
  } else if (process.argv[2] === 'package') await checkPackage(root);
  else if (process.argv[2] === 'playwright-variant') await writeFile(process.argv[4], JSON.stringify(await playwrightVariant(process.argv[3], process.env)));
  else if (process.argv[2] === 'fixture') await checkFixture(root, process.argv[3]);
  else throw new Error('Usage: node scripts/ci.mjs release|package|fixture');
}
