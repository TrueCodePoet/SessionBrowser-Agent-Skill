import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, validateCommand, validateSite, safeUrl, redact } from '../scripts/policy.mjs';

test('headed default and headless opt-in share a persistent profile', () => {
  const environment = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' };
  const headed = settings([], environment);
  const headless = settings(['--headless'], environment);
  assert.equal(headed.headless, false);
  assert.equal(headed.channel, 'msedge');
  assert.equal(settings(['--channel', 'chromium'], environment).channel, 'chromium');
  assert.throws(() => settings(['--channel', 'unsupported'], environment));
  assert.equal(headless.headless, true);
  assert.equal(headed.profilePath, headless.profilePath);
  assert.match(headed.pipe, /session-browser/);
  assert.throws(() => settings(['--profile', '../escape'], environment));
});

test('raw browser and credential extraction commands are unavailable', () => {
  for (const command of ['eval', 'html', 'cookies', 'saveStorageState', 'requests', 'console', 'credentials']) {
    assert.throws(() => validateCommand({ command }));
  }
  assert.equal(validateCommand({ command: 'snapshot' }).command, 'snapshot');
});

test('credentials require exact HTTPS origins and local aliases', () => {
  const site = {
    credentialAlias: 'example-personal', loginUrl: 'https://example.com/login',
    allowedOrigins: ['https://example.com'], usernameSelector: '#user',
    passwordSelector: '#password', submitSelector: '#login', successSelector: '#account',
  };
  assert.equal(validateSite(site), site);
  assert.throws(() => validateSite({ ...site, loginUrl: 'http://example.com/login' }));
  assert.throws(() => validateSite({ ...site, allowedOrigins: ['https://example.com.evil.test'] }));
  assert.throws(() => validateSite({ ...site, credentialAlias: '../secret' }));
});

test('output strips URL tokens and known secrets including encoded forms', () => {
  assert.equal(safeUrl('about:blank'), 'about:blank');
  assert.equal(safeUrl('https://example.com/account?token=secret#secret'), 'https://example.com/account');
  assert.deepEqual(redact({ text: 'password! password%21' }, ['password!']), { text: '[REDACTED] password%21' });
  assert.deepEqual(redact({ text: 'a b a%20b' }, ['a b']), { text: '[REDACTED] [REDACTED]' });
});