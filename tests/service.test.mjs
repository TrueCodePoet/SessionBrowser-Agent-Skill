import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const workerPath = fileURLToPath(new URL('../scripts/browser.mjs', import.meta.url));
const brokerPath = fileURLToPath(new URL('../scripts/credential-store.ps1', import.meta.url));

test('live pipe supports reattachment, tab control, and graceful shutdown', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-browser-service-'));
  const environment = { ...process.env, LOCALAPPDATA: root };
  const worker = spawn(process.execPath, [workerPath, 'serve', '--headless', '--channel',
    process.env.SESSION_BROWSER_TEST_CHANNEL || 'msedge'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => worker.once('exit', resolve));
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker readiness timed out')), 25000);
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('Worker exited before readiness')); });
      worker.stdout.once('data', chunk => { clearTimeout(timer); resolve(JSON.parse(chunk.toString())); });
    });
    assert.equal(ready.status, 'ready');
    const { stdout: processFlags } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${worker.pid}' | ` +
      "Where-Object { $_.Name -in @('msedge.exe', 'chrome.exe') } | " +
      "ForEach-Object { @{ noSandbox = $_.CommandLine -match '--no-sandbox'; name = $_.Name } } | ConvertTo-Json -AsArray"],
    { timeout: 15000 });
    const browsers = JSON.parse(processFlags);
    assert.ok(browsers.length > 0, 'Expected a browser child process');
    assert.ok(browsers.every(browser => !browser.noSandbox), 'Browser must not disable its sandbox');
    const send = async command => {
      const { stdout } = await execute(process.execPath, [workerPath, 'send', JSON.stringify(command)],
        { env: environment, timeout: 15000 });
      return JSON.parse(stdout);
    };
    const status = await send({ command: 'status' });
    assert.equal(status.result.mode, 'headless');
    assert.equal(status.result.tabs.length, 1);
    await send({ command: 'newTab' });
    assert.equal((await send({ command: 'tabs' })).result.tabs.length, 2);
    const snapshot = await send({ command: 'snapshot' });
    assert.equal(snapshot.ok, true);
    assert.equal((await send({ command: 'stop' })).result.status, 'stopped');
    assert.equal(await exited, 0);
  } finally {
    if (worker.exitCode === null) worker.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows DPAPI broker round trip and deletion use only synthetic credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-browser-vault-test-'));
  const environment = { ...process.env, LOCALAPPDATA: root };
  try {
    await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $vault=Join-Path $env:LOCALAPPDATA 'SessionBrowser/vault'; " +
      "New-Item -ItemType Directory -Path $vault -Force | Out-Null; " +
      "$password=ConvertTo-SecureString 'synthetic-password-only' -AsPlainText -Force; " +
      "$credential=[pscredential]::new('synthetic-user', $password); " +
      "$credential | Export-Clixml -LiteralPath (Join-Path $vault 'synthetic.credential.xml')"], { env: environment });
    const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', brokerPath,
      '-Action', 'Read', '-Alias', 'synthetic'], { env: environment });
    assert.deepEqual(JSON.parse(stdout), { username: 'synthetic-user', password: 'synthetic-password-only' });
    await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', brokerPath,
      '-Action', 'Remove', '-Alias', 'synthetic'], { env: environment });
    await assert.rejects(execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', brokerPath,
      '-Action', 'Read', '-Alias', 'synthetic'], { env: environment }), error => {
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /Credential operation failed/);
      assert.equal(error.stderr.includes('synthetic-password-only'), false);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});