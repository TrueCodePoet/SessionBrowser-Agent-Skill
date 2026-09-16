import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { settings } from './policy.mjs';
import { hostName } from '../extension/policy.mjs';

export function registrationPlan(extensionId, browser, profile, environment = process.env) {
  if (!/^[a-p]{32}$/.test(extensionId ?? '')) throw new Error('Use the 32-character extension ID shown by the browser');
  if (!['edge', 'chrome'].includes(browser)) throw new Error('Use --browser edge or chrome');
  const config = settings(['--profile', profile || `attached-${browser}`], environment);
  const directory = path.join(config.root, 'connector', browser);
  const configPath = path.join(directory, 'config.json');
  const manifestPath = path.join(directory, 'host.json');
  const launcherPath = path.join(directory, 'host.cmd');
  const workerPath = fileURLToPath(new URL('./native-host.mjs', import.meta.url));
  for (const value of [process.execPath, workerPath, configPath]) {
    const normalized = path.normalize(value);
    if (normalized !== value || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069"%!]/u.test(value)) {
      throw new Error('Unsupported character or non-normalized path in installation path');
    }
  }
  return {
    directory, configPath, manifestPath, launcherPath,
    registryKey: `HKCU\\Software\\${browser === 'edge' ? 'Microsoft\\Edge' : 'Google\\Chrome'}\\NativeMessagingHosts\\${hostName}`,
    configuration: { extensionId, profile: config.profile },
    manifest: { name: hostName, description: 'Session Browser selected-tab connector', path: launcherPath,
      type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] },
    launcher: `@echo off\r\n"${process.execPath}" "${workerPath}" --config "${configPath}" %*\r\n`,
  };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This installer currently supports Windows only');
  const args = process.argv.slice(2);
  const argument = name => args[args.indexOf(name) + 1];
  if (!args.includes('--extension-id') || !args.includes('--browser')) throw new Error('Required: --extension-id ID --browser edge|chrome');
  const plan = registrationPlan(argument('--extension-id'), argument('--browser'),
    args.includes('--profile') ? argument('--profile') : undefined);
  if (args.includes('--uninstall')) {
    await promisify(execFile)('reg.exe', ['delete', plan.registryKey, '/f'], { windowsHide: true });
    console.log(JSON.stringify({ ok: true, status: 'unregistered', profile: plan.configuration.profile }));
    return;
  }
  await mkdir(plan.directory, { recursive: true });
  await writeFile(plan.configPath, JSON.stringify(plan.configuration, null, 2));
  await writeFile(plan.manifestPath, JSON.stringify(plan.manifest, null, 2));
  await writeFile(plan.launcherPath, plan.launcher, 'utf8');
  await promisify(execFile)('reg.exe', ['add', plan.registryKey, '/ve', '/t', 'REG_SZ', '/d', plan.manifestPath, '/f'], { windowsHide: true });
  console.log(JSON.stringify({ ok: true, status: 'registered', profile: plan.configuration.profile, extensionId: plan.configuration.extensionId }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}