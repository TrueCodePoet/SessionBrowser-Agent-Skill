import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeNative, nativeDecoder, maxNativeBytes } from '../scripts/native-protocol.mjs';
import { authorize, originOf, tabSummary } from '../extension/policy.mjs';
import { Connector } from '../extension/controller.mjs';
import { registrationPlan } from '../scripts/register-connector.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

test('native framing handles split and coalesced UTF-8 messages', () => {
  const received = [];
  const decode = nativeDecoder(message => received.push(message));
  const first = encodeNative({ text: 'caf\u00e9' });
  const second = encodeNative({ ok: true });
  decode(first.subarray(0, 2));
  decode(first.subarray(2, 6));
  assert.deepEqual(received, []);
  decode(Buffer.concat([first.subarray(6), second]));
  assert.deepEqual(received, [{ text: 'caf\u00e9' }, { ok: true }]);
  const invalid = Buffer.alloc(4);
  invalid.writeUInt32LE(maxNativeBytes + 1);
  assert.throws(() => nativeDecoder(() => {})(invalid));
  assert.throws(() => nativeDecoder(() => {})(Buffer.alloc(4)));
});

test('connector grants are bound to an explicit tab, origin, and control permission', () => {
  const tab = { id: 42, url: 'https://example.com/account?private=not-exported' };
  const grant = { tab: 42, origin: 'https://example.com', control: false };
  assert.doesNotThrow(() => authorize({ command: 'snapshot' }, grant, tab));
  assert.throws(() => authorize({ command: 'snapshot' }, null, tab));
  assert.throws(() => authorize({ command: 'snapshot' }, grant, { ...tab, id: 43 }));
  assert.throws(() => authorize({ command: 'snapshot' }, grant, { ...tab, url: 'https://elsewhere.test' }));
  assert.throws(() => authorize({ command: 'click' }, grant, tab));
  const control = { ...grant, control: true };
  assert.doesNotThrow(() => authorize({ command: 'click' }, control, tab));
  assert.doesNotThrow(() => authorize({ command: 'goto', url: 'https://example.com/next' }, control, tab));
  assert.throws(() => authorize({ command: 'goto', url: 'https://elsewhere.test' }, control, tab));
  for (const command of ['eval', 'cookies', 'login', 'screenshot', 'newTab']) {
    assert.throws(() => authorize({ command }, control, tab));
  }
  for (const url of ['file:///private', 'edge://settings', 'https://user:password@example.com']) {
    assert.throws(() => originOf(url));
  }
  assert.deepEqual(tabSummary(grant), { id: '42', origin: 'https://example.com', access: 'read' });
});

test('controller refuses unshared tabs, applies permissions, and revokes origin changes', async () => {
  const tabs = new Map([[1, { id: 1, windowId: 1, url: 'https://example.com/account' }],
    [2, { id: 2, windowId: 1, url: 'https://private.test', incognito: true }]]);
  let calls = 0;
  const api = {
    tabs: { get: async id => tabs.get(id), update: async () => {} },
    windows: { update: async () => {} }, action: { setBadgeText: async () => {} },
    scripting: { executeScript: async options => {
      calls++;
      assert.equal(options.world, 'ISOLATED');
      assert.deepEqual(options.target.frameIds, [0]);
      return [{ result: { status: 'ok' } }];
    } },
  };
  const connector = new Connector(api);
  assert.equal((await connector.run({ command: 'snapshot' })).ok, false);
  await assert.rejects(connector.share(2));
  await connector.share(1);
  assert.equal((await connector.run({ command: 'snapshot' })).ok, true);
  assert.equal((await connector.run({ command: 'click' })).ok, false);
  assert.equal(calls, 1);
  await connector.share(1, true);
  assert.equal((await connector.run({ command: 'click' })).ok, true);
  tabs.set(1, { ...tabs.get(1), url: 'https://elsewhere.test' });
  assert.equal((await connector.run({ command: 'snapshot' })).ok, false);
  assert.equal(connector.grants.size, 0);
  assert.equal(calls, 2);
  tabs.set(1, { ...tabs.get(1), url: 'https://example.com/account' });
  await connector.share(1);
  await connector.run({ command: 'stop' });
  assert.equal(connector.grants.size, 0);
});

test('registration is current-user only and pins a single extension origin', () => {
  const environment = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' };
  const plan = registrationPlan('a'.repeat(32), 'edge', undefined, environment);
  assert.match(plan.registryKey, /^HKCU\\Software\\Microsoft\\Edge/);
  assert.equal(plan.configuration.profile, 'attached-edge');
  assert.deepEqual(plan.manifest.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]);
  assert.match(plan.launcher, /--config/);
  assert.throws(() => registrationPlan('*', 'edge', undefined, environment));
  assert.throws(() => registrationPlan('a'.repeat(32), 'firefox', undefined, environment));
});

test('native host bridges the CLI to the extension and rejects an unapproved origin', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'connector-test-'));
  const extensionId = 'a'.repeat(32);
  const hostPath = fileURLToPath(new URL('../scripts/native-host.mjs', import.meta.url));
  const clientPath = fileURLToPath(new URL('../scripts/browser.mjs', import.meta.url));
  const environment = { ...process.env, LOCALAPPDATA: root };
  const plan = registrationPlan(extensionId, 'edge', 'attached-test', environment);
  await mkdir(plan.directory, { recursive: true });
  await writeFile(plan.configPath, JSON.stringify(plan.configuration));
  await writeFile(plan.launcherPath, plan.launcher);
  const worker = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c',
    `""${plan.launcherPath}" chrome-extension://${extensionId}/"`],
  { env: environment, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => worker.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native host timed out')), 10000);
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.stdout.on('data', nativeDecoder(message => {
        if (message.type === 'connected') { clearTimeout(timer); resolve(); }
        if (message.type === 'command') worker.stdin.write(encodeNative({ type: 'result', id: message.id,
          result: { ok: true, result: { status: message.command.command === 'stop' ? 'disconnected' : 'connected',
            mode: 'connected', tabs: [] } } }));
      }));
      worker.stdin.write(encodeNative({ type: 'ready' }));
    });
    const send = async command => {
      const { stdout } = await promisify(execFile)(process.execPath,
        [clientPath, 'send', JSON.stringify(command), '--profile', 'attached-test'], { env: environment, timeout: 10000 });
      return JSON.parse(stdout);
    };
    assert.equal((await send({ command: 'status' })).result.mode, 'connected');
    assert.equal((await send({ command: 'stop' })).result.status, 'disconnected');
    assert.equal(await exited, 0);
    await assert.rejects(promisify(execFile)(process.execPath,
      [hostPath, '--config', plan.configPath, `chrome-extension://${'b'.repeat(32)}/`], { env: environment, timeout: 10000 }),
    error => error.code === 1 && error.stdout === '');
  } finally {
    if (worker.exitCode === null) worker.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

test('Edge loads the real extension with only selected-tab permissions', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'connector-load-test-'));
  const extension = fileURLToPath(new URL('../extension', import.meta.url));
  const context = await chromium.launchPersistentContext(root, {
    channel: 'msedge', headless: true, chromiumSandbox: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'nativeMessaging']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.incognito, 'not_allowed');
    const popup = await context.newPage();
    const extensionId = new URL(worker.url()).host;
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    assert.equal(await popup.locator('h1').innerText(), 'Session Browser');
    assert.equal(await popup.locator('#extension-id').innerText(), extensionId);
    assert.equal(await popup.locator('#control').isChecked(), false);
    const screenshots = fileURLToPath(new URL('../test-results', import.meta.url));
    await mkdir(screenshots, { recursive: true });
    for (const width of [360, 320]) {
      await popup.setViewportSize({ width, height: 580 });
      assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await popup.screenshot({ path: path.join(screenshots, `connector-${width}.png`) });
    }
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});