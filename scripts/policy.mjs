import { createHash } from 'node:crypto';
import path from 'node:path';

export function settings(args, environment = process.env) {
  const profileIndex = args.indexOf('--profile');
  const profile = profileIndex < 0 ? 'personal' : args[profileIndex + 1];
  if (!profile || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(profile)) throw new Error('Invalid profile name');
  const channelIndex = args.indexOf('--channel');
  const channel = channelIndex < 0 ? 'msedge' : args[channelIndex + 1];
  if (!['chrome', 'msedge', 'chromium'].includes(channel)) throw new Error('Unsupported channel');
  const base = environment.LOCALAPPDATA;
  if (!base) throw new Error('Windows LOCALAPPDATA is required');
  const root = path.join(base, 'SessionBrowser');
  const identity = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 20);
  return {
    root, profile, channel, headless: args.includes('--headless'),
    pipe: `\\\\.\\pipe\\session-browser-${identity}-${profile}`,
    profilePath: path.join(root, 'profiles', profile),
    sitesPath: path.join(root, 'sites.json'),
    vaultPath: path.join(root, 'vault'),
  };
}

export const commands = new Set([
  'status', 'tabs', 'newTab', 'useTab', 'closeTab', 'goto', 'back',
  'snapshot', 'click', 'fill', 'press', 'select', 'check', 'scroll',
  'wait', 'screenshot', 'login', 'diagnostics', 'stop',
]);

export function validateCommand(command) {
  if (!command || !commands.has(command.command)) throw new Error('Unsupported command');
  return command;
}

export function webUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are allowed');
  }
  return url;
}

export function validateSite(site) {
  if (!site || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(site.credentialAlias ?? '')) {
    throw new Error('Invalid credential alias');
  }
  const login = webUrl(site.loginUrl);
  if (login.protocol !== 'https:') throw new Error('Login requires HTTPS');
  if (!Array.isArray(site.allowedOrigins) || !site.allowedOrigins.includes(login.origin)) {
    throw new Error('Login origin must be explicitly allowed');
  }
  for (const origin of site.allowedOrigins) {
    const parsed = webUrl(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) throw new Error('Use exact HTTPS origins');
  }
  for (const key of ['usernameSelector', 'passwordSelector', 'submitSelector', 'successSelector']) {
    if (typeof site[key] !== 'string' || !site[key]) throw new Error(`Missing ${key}`);
  }
  return site;
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return 'about:blank';
    return `${url.origin}${url.pathname}`;
  } catch { return 'about:blank'; }
}

export function redact(value, secrets) {
  let text = JSON.stringify(value);
  for (const secret of secrets) {
    if (!secret) continue;
    for (const variant of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) {
      text = text.split(JSON.stringify(variant).slice(1, -1)).join('[REDACTED]');
    }
  }
  return JSON.parse(text);
}