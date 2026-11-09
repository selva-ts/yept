// Store screenshots: drives the development extension through its commands, with the synthetic sample collection,
// and captures the window after each step. Started by run.mjs; Windows only.
const vscode = require('vscode');
const { execFileSync } = require('node:child_process');
const { join, resolve } = require('node:path');

const out = process.env.YEPT_SHOTS_OUT;
const runButton = process.env.YEPT_SHOTS_RUN_BUTTON;
const capture = join(__dirname, 'capture.ps1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (condition, what, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    if (await condition()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const window = (...args) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', capture, '-Title', 'Yept screenshots', ...args], { encoding: 'utf8' });
const shot = async (name) => {
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(2500);
  console.log(name, window('-Out', join(out, `${name}.png`)).trim());
};

exports.run = async function run() {
  const extension = vscode.extensions.all.find((e) => resolve(e.extensionPath).toLowerCase() === resolve(__dirname, '../..').toLowerCase());
  const api = await extension.activate();
  await api.ready;
  window('-Resize', '-Width', '1600', '-Height', '1000');
  await sleep(1500);
  // Services start with the first panel, so the one folder's services are looked up after the runner opens.
  const invoke = (channel, ...args) => [...api.services.values()][0].handlers.invoke(channel, ...args);
  const collections = () => api.collections.snapshots()[0].collections;
  const travel = collections().find((c) => c.name === 'Sample Travel');
  const treeItem = (kind, name) => {
    const find = (items) => {
      for (const item of items) {
        if (item.kind === kind && item.name === name) return item;
        const child = find(api.collections.getChildren(item));
        if (child) return child;
      }
      return undefined;
    };
    return find(api.collections.getChildren());
  };

  await vscode.commands.executeCommand('workbench.action.closePanel');
  // Expand the collection and both folders.
  await vscode.commands.executeCommand('yept.collections.focus');
  for (const command of ['list.focusFirst', 'list.expand', 'list.focusDown', 'list.expand', 'list.focusDown', 'list.focusDown', 'list.expand', 'list.focusDown']) {
    await vscode.commands.executeCommand(command);
    await sleep(250);
  }

  // The runner, with the sample's secret entered and its environment active, run from its own page.
  await vscode.commands.executeCommand('yept.runCollection', treeItem('collection', 'Sample Travel'));
  await until(() => api.runner()?.state?.target?.name === 'Sample Travel', 'the runner page');
  await invoke('env:set-secret', travel.id, 'local', 'clientSecret', 'sample-secret');
  await invoke('env:set-active', travel.id, 'local');
  api.runner().panel.dispose();
  await sleep(500);
  await vscode.commands.executeCommand('yept.runCollection', treeItem('collection', 'Sample Travel'));
  await until(() => api.runner()?.state?.target?.name === 'Sample Travel', 'the runner page');
  const runner = api.runner();
  await sleep(2000);
  if (!runButton) {
    // Without the button's place, capture the page so it can be found.
    await shot('runner-before');
    return;
  }
  window('-Click', runButton);
  await until(() => api.runner()?.state?.run && !api.runner().state.run.running, 'the run to end');
  await shot('runner');
  runner.panel.dispose();

  // A request panel showing the run of List bookings, with Dev Tools below.
  const visit = (nodes) => nodes.flatMap((n) => [n, ...visit(n.children ?? [])]);
  const bookings = visit(collections()).find((n) => n.kind === 'request' && n.name === 'List bookings');
  await vscode.commands.executeCommand('yept.openRequest', bookings.id);
  await until(() => api.history.view.description === 'List bookings', 'History to follow the panel');
  await sleep(1500);
  const [latest] = api.history.getChildren();
  if (latest) await vscode.commands.executeCommand('yept.history.open', latest);
  await vscode.commands.executeCommand('yept.showDevTools');
  await until(() => api.devtools().ready, 'Dev Tools');
  const panel = api.panels().find((p) => p.requestId === bookings.id).panel;
  panel.reveal(panel.viewColumn, false);
  await shot('request');

  // The environments editor.
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('yept.manageEnvironments', treeItem('collection', 'Sample Travel'));
  await shot('environments');
};
