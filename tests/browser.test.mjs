import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { BrowserSession } from '../scripts/session.mjs';
import { pageAction } from '../extension/page-action.mjs';

const origin = 'https://fixture.test';
const channel = process.env.SESSION_BROWSER_TEST_CHANNEL || 'msedge';
const synthetic = { username: 'synthetic-user@example.test', password: 'synthetic-password-only' };
const recipe = {
  credentialAlias: 'synthetic', loginUrl: `${origin}/login`, allowedOrigins: [origin],
  usernameSelector: '#username', passwordSelector: '#password',
  submitSelector: '#submit', successSelector: '#account',
};

async function fixture(headless) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-browser-test-'));
  const config = { root, profile: 'test', headless, sitesPath: path.join(root, 'sites.json') };
  await writeFile(config.sitesPath, JSON.stringify({ fixture: recipe }));
  const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
    headless, channel, chromiumSandbox: true, serviceWorkers: 'block',
  });
  let brokerCalls = 0;
  const session = new BrowserSession(context, config, async alias => {
    assert.equal(alias, 'synthetic');
    brokerCalls++;
    return synthetic;
  });
  await context.route(`${origin}/**`, route => route.fulfill({
    contentType: 'text/html', body: `<!doctype html><html><body>
      <h1>Fixture</h1><form action="/account" method="post">
      <label>Username<input id="username" name="username"></label>
      <label>Password<input id="password" name="password" type="password"></label>
      <label>PIN<input id="pin" name="pin" inputmode="numeric"></label>
      <button id="submit" type="submit">Log in</button></form>
      <label>Search<input id="search" name="search"></label>
      <script>document.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        const message = document.createElement('p'); message.id = 'account';
        message.textContent = document.querySelector('#username').value + ' ' + document.querySelector('#password').value;
        document.body.append(message);
      });</script></body></html>`,
  }));
  return { context, config, session, brokerCalls: () => brokerCalls,
    cleanup: async () => { await context.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const headless of [true, false]) {
  test(`${headless ? 'headless' : 'headed'}: navigation, broker login, redaction, tabs, and persistence`, async () => {
    const browser = await fixture(headless);
    try {
      const { session, context, config } = browser;
      assert.equal((await session.run({ command: 'status' })).result.mode, headless ? 'headless' : 'headed');
      assert.equal((await session.run({ command: 'goto', url: `${origin}/login` })).ok, true);
      assert.equal((await session.run({ command: 'fill', selector: '#search', text: 'ordinary query' })).ok, true);
      assert.equal((await session.run({ command: 'fill', selector: '#password', text: 'not-a-real-secret' })).ok, false);
      assert.equal((await session.run({ command: 'screenshot' })).ok, false);
      const login = await session.run({ command: 'login', site: 'fixture' });
      assert.equal(login.result.status, 'authenticated');
      assert.equal(browser.brokerCalls(), 1);
      assert.equal(await session.page().locator('#username').inputValue(), '');
      assert.equal(await session.page().locator('#password').inputValue(), '');
      const snapshot = await session.run({ command: 'snapshot' });
      const output = JSON.stringify(snapshot);
      assert.equal(output.includes(synthetic.username), false);
      assert.equal(output.includes(synthetic.password), false);
      assert.equal(output.includes('ordinary query'), false);
      assert.match(output, /REDACTED/);
      assert.equal((await session.run({ command: 'eval', script: 'document.cookie' })).ok, false);
      await context.addCookies([{ name: 'synthetic-session', value: 'test-only', domain: 'fixture.test', path: '/',
        secure: true, expires: Math.floor(Date.now() / 1000) + 3600 }]);
      const firstTab = session.active;
      await session.run({ command: 'newTab', url: `${origin}/other` });
      assert.equal(session.pages.size, 2);
      await session.run({ command: 'useTab', tab: firstTab });
      assert.equal(session.active, firstTab);
      assert.equal((await session.run({ command: 'stop' })).ok, true);
      const reopened = await chromium.launchPersistentContext(path.join(config.root, 'profile'), { headless: !headless, channel, chromiumSandbox: true });
      try {
        assert.equal((await reopened.cookies()).find(cookie => cookie.name === 'synthetic-session')?.value, 'test-only');
      } finally { await reopened.close(); }
    } finally { await browser.cleanup(); }
  });
}

test('unapproved form destination is rejected before the broker reads credentials', async () => {
  const browser = await fixture(true);
  try {
    await browser.context.unrouteAll();
    await browser.context.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body:
      '<form action="https://unapproved.test/steal"><input id="username"><input id="password" type="password"><button id="submit">Log in</button></form>' }));
    const response = await browser.session.run({ command: 'login', site: 'fixture' });
    assert.equal(response.result.status, 'needs_user_action');
    assert.equal(browser.brokerCalls(), 0);
  } finally { await browser.cleanup(); }
});

test('manually filled values and raw errors never appear in snapshots or failures', async () => {
  const browser = await fixture(true);
  try {
    await browser.session.run({ command: 'goto', url: `${origin}/login` });
    await browser.session.page().locator('#username').fill('manual-user-marker');
    await browser.session.page().locator('#password').fill('manual-password-marker');
    const output = JSON.stringify(await browser.session.run({ command: 'snapshot' }));
    assert.equal(output.includes('manual-user-marker'), false);
    assert.equal(output.includes('manual-password-marker'), false);
    const failure = JSON.stringify(await browser.session.run({ command: 'click', selector: 'invalid[private-marker' }));
    assert.equal(failure.includes('private-marker'), false);
  } finally { await browser.cleanup(); }
});

test('opt-in diagnostics capture identity and allowlisted headers without authentication data', async () => {
  const browser = await fixture(true);
  try {
    await browser.context.setExtraHTTPHeaders({
      authorization: 'Bearer synthetic-authorization-marker',
      'x-secret': 'synthetic-custom-marker',
    });
    await browser.context.addCookies([{ name: 'test-secret', value: 'synthetic-cookie-marker', url: origin }]);
    await browser.session.run({ command: 'goto', url: `${origin}/before` });
    const inactive = await browser.session.run({ command: 'diagnostics' });
    assert.equal(inactive.result.enabled, false);
    assert.equal(inactive.result.requests.length, 0);
    assert.equal((await browser.session.run({ command: 'diagnostics', action: 'start' })).ok, true);
    await browser.session.run({ command: 'goto', url: `${origin}/secret-path-marker?token=secret-query-marker` });
    const response = await browser.session.run({ command: 'diagnostics' });
    assert.equal(response.result.enabled, true);
    assert.match(response.result.browser.userAgent, /Chrome/);
    assert.equal(typeof response.result.browser.webdriver, 'boolean');
    const request = response.result.requests.find(event => event.type === 'document');
    assert.equal(request.origin, origin);
    assert.equal(request.status, 200);
    assert.match(request.headers['user-agent'], /Chrome/);
    const serialized = JSON.stringify(response);
    for (const marker of ['synthetic-authorization-marker', 'synthetic-custom-marker', 'synthetic-cookie-marker',
      'secret-path-marker', 'secret-query-marker']) assert.equal(serialized.includes(marker), false);
    assert.equal(Object.hasOwn(request.headers, 'cookie'), false);
    assert.equal(Object.hasOwn(request.headers, 'authorization'), false);
    assert.deepEqual((await browser.session.run({ command: 'diagnostics', action: 'stop' })).result, { enabled: false });
    assert.equal((await browser.session.run({ command: 'diagnostics' })).result.requests.length, 0);
  } finally { await browser.cleanup(); }
});

test('connector page actions omit form values and block protected fields and origin changes', async () => {
  const browser = await fixture(true);
  try {
    await browser.session.run({ command: 'goto', url: `${origin}/login` });
    const page = browser.session.page();
    await page.locator('#username').fill('manual-user-not-exported');
    await page.locator('#password').fill('manual-secret-not-exported');
    const invoke = (command, expectedOrigin = origin) => page.evaluate(pageAction, { command, expectedOrigin });
    const snapshot = await invoke({ command: 'snapshot' });
    assert.equal(JSON.stringify(snapshot).includes('manual-user-not-exported'), false);
    assert.equal(JSON.stringify(snapshot).includes('manual-secret-not-exported'), false);
    await assert.rejects(invoke({ command: 'fill', selector: '#password', text: 'never-filled' }));
    await assert.rejects(invoke({ command: 'fill', selector: '#pin', text: 'never-filled' }));
    await assert.rejects(invoke({ command: 'fill', selector: '#search', text: 'x'.repeat(1001) }));
    await assert.rejects(invoke({ command: 'snapshot' }, 'https://elsewhere.test'));
    await invoke({ command: 'fill', selector: '#search', text: 'ordinary search' });
    assert.equal(await page.locator('#search').inputValue(), 'ordinary search');
    assert.equal(JSON.stringify(await invoke({ command: 'snapshot' })).includes('ordinary search'), false);
    await assert.rejects(invoke({ command: 'goto', url: 'https://elsewhere.test' }));
  } finally { await browser.cleanup(); }
});