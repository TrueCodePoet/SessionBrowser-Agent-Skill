import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateCommand, validateSite, webUrl, safeUrl, redact } from './policy.mjs';

const execute = promisify(execFile);

async function readCredential(alias) {
  const script = fileURLToPath(new URL('./credential-store.ps1', import.meta.url));
  const { stdout } = await execute('pwsh.exe', [
    '-NoProfile', '-NonInteractive', '-File', script, '-Action', 'Read', '-Alias', alias,
  ], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
  const credential = JSON.parse(stdout);
  if (typeof credential.username !== 'string' || !credential.username ||
      typeof credential.password !== 'string' || !credential.password) throw new Error('Invalid credential');
  return credential;
}

export class BrowserSession {
  constructor(context, config, broker = readCredential) {
    this.context = context;
    this.config = config;
    this.broker = broker;
    this.pages = new Map();
    this.secrets = new Set();
    this.nextTab = 1;
    this.active = null;
    this.stopped = false;
    this.diagnosticCapture = null;
    context.setDefaultTimeout(10000);
    context.setDefaultNavigationTimeout(20000);
    context.on('page', page => this.register(page));
    for (const page of context.pages()) this.register(page);
  }

  register(page) {
    if ([...this.pages.values()].includes(page)) return;
    const id = String(this.nextTab++);
    this.pages.set(id, page);
    this.active = id;
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('close', () => {
      this.pages.delete(id);
      if (this.active === id) this.active = this.pages.keys().next().value ?? null;
    });
  }

  page() {
    const page = this.pages.get(this.active);
    if (!page || page.isClosed()) throw new Error('No active tab');
    return page;
  }

  locator(page, command) {
    if (typeof command.selector === 'string' && command.selector.length <= 1000) return page.locator(command.selector);
    if (typeof command.role === 'string') return page.getByRole(command.role, { name: command.name, exact: true });
    if (typeof command.label === 'string') return page.getByLabel(command.label, { exact: true });
    throw new Error('Use selector, role/name, or label');
  }

  async safeTarget(locator) {
    const protectedField = await locator.evaluate(element => {
      const description = ['type', 'name', 'id', 'autocomplete', 'aria-label', 'placeholder']
        .map(attribute => element.getAttribute(attribute) ?? '').join(' ');
      return /password|passwd|passcode|secret|token|username|user.?name|email|one.?time|otp|\bpin\b|credit.?card|cc-number|cc-cvc|cvv|cvc/i.test(description);
    });
    if (protectedField) throw new Error('Use local authentication or manual input for protected fields');
  }

  async snapshot(page) {
    return page.evaluate(() => {
      const visible = element => !!(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
      const root = document.body.cloneNode(true);
      root.querySelectorAll('input, textarea, select, [contenteditable], script, style, noscript, iframe, [hidden], [aria-hidden="true"]')
        .forEach(element => element.remove());
      const originals = [...document.body.querySelectorAll('*')];
      const hiddenText = originals.filter(element => !visible(element)).map(element => element.textContent).filter(Boolean);
      let text = root.textContent ?? '';
      for (const hidden of hiddenText) text = text.split(hidden).join('');
      const controls = [...document.querySelectorAll('a, button, input, textarea, select, [role="button"], [contenteditable]')]
        .filter(visible).slice(0, 100).map(element => ({
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          type: element.getAttribute('type'),
          label: element.labels?.[0]?.innerText || element.getAttribute('aria-label') ||
            (['BUTTON', 'A'].includes(element.tagName) ? element.innerText : ''),
        }));
      return { text: text.replace(/\s+/g, ' ').trim().slice(0, 12000), controls };
    });
  }

  async login(page, alias) {
    const sites = JSON.parse(await readFile(this.config.sitesPath, 'utf8'));
    if (typeof alias !== 'string' || !Object.hasOwn(sites, alias)) throw new Error('Unknown site alias');
    const site = validateSite(sites[alias]);
    const allowed = new Set(site.allowedOrigins);
    let blocked = false;
    const guard = async route => {
      if (!allowed.has(new URL(route.request().url()).origin)) {
        blocked = true;
        await route.abort();
      } else await route.fallback();
    };
    await this.context.route('**/*', guard);
    try {
      await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded' });
      if (!allowed.has(new URL(page.url()).origin)) throw new Error('Unexpected login origin');
      if (await page.locator(site.successSelector).isVisible()) return { status: 'already_authenticated' };
      const username = page.locator(site.usernameSelector);
      const password = page.locator(site.passwordSelector);
      await username.waitFor({ state: 'visible' });
      await password.waitFor({ state: 'visible' });
      for (const field of [username, password]) {
        const destination = await field.evaluate(element => ({
          origin: location.origin, action: element.form?.action || location.href,
        }));
        if (!allowed.has(destination.origin) || !allowed.has(new URL(destination.action).origin)) {
          throw new Error('Unexpected credential destination');
        }
      }
      const credential = await this.broker(site.credentialAlias);
      this.secrets.add(credential.username);
      this.secrets.add(credential.password);
      await username.fill(credential.username);
      await password.fill(credential.password);
      await page.locator(site.submitSelector).click();
      await page.locator(site.successSelector).waitFor({ state: 'visible', timeout: 15000 });
      if (!allowed.has(new URL(page.url()).origin)) throw new Error('Unexpected success origin');
      return { status: 'authenticated' };
    } catch {
      return { status: 'needs_user_action', blockedExternalOrigin: blocked,
        message: 'Login not verified. Check the browser for MFA, CAPTCHA, site errors, or missing local credentials. No automatic retry.' };
    } finally {
      await page.locator(site.usernameSelector).fill('', { timeout: 500 }).catch(() => {});
      await page.locator(site.passwordSelector).fill('', { timeout: 500 }).catch(() => {});
      await this.context.unroute('**/*', guard);
    }
  }

  async diagnostics(action = 'read') {
    if (!['start', 'read', 'stop'].includes(action)) throw new Error('Invalid diagnostic action');
    if (action === 'start' || action === 'stop') {
      if (this.diagnosticCapture) {
        this.diagnosticCapture.page.off('response', this.diagnosticCapture.listener);
        this.diagnosticCapture = null;
      }
    }
    if (action === 'stop') return { enabled: false };
    if (action === 'start') {
      const page = this.page();
      const capture = { page, events: [], pending: new Set() };
      capture.listener = response => {
        const request = response.request();
        if (!['document', 'fetch', 'xhr'].includes(request.resourceType())) return;
        try { if (request.frame() !== page.mainFrame()) return; } catch { return; }
        const event = { origin: new URL(request.url()).origin, method: request.method(),
          type: request.resourceType(), status: response.status(), headers: {} };
        capture.events.push(event);
        if (capture.events.length > 20) capture.events.shift();
        const pending = (async () => {
          for (const name of ['user-agent', 'accept', 'accept-language', 'content-type',
            'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
            'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user', 'origin', 'referer']) {
            const value = await request.headerValue(name);
            if (value !== null) {
              event.headers[name] = ['origin', 'referer'].includes(name)
                ? new URL(value).origin : value.slice(0, 1024);
            }
          }
        })().catch(() => { event.headersIncomplete = true; });
        capture.pending.add(pending);
        pending.finally(() => capture.pending.delete(pending));
      };
      this.diagnosticCapture = capture;
      page.on('response', capture.listener);
    }
    const capture = this.diagnosticCapture;
    if (capture) await Promise.all([...capture.pending]);
    const page = capture?.page ?? this.page();
    const browser = await page.evaluate(() => ({
      userAgent: navigator.userAgent, webdriver: navigator.webdriver,
      language: navigator.language, languages: navigator.languages,
      cookiesEnabled: navigator.cookieEnabled, online: navigator.onLine,
      clientHints: navigator.userAgentData?.toJSON() ?? null,
    }));
    return { enabled: !!capture, browser, requests: capture?.events ?? [] };
  }

  async dispatch(command) {
    validateCommand(command);
    if (this.stopped) throw new Error('Session stopped');
    if (command.command === 'status' || command.command === 'tabs') {
      return { mode: this.config.headless ? 'headless' : 'headed', channel: this.config.channel, profile: this.config.profile,
        activeTab: this.active, tabs: [...this.pages].map(([id, page]) => ({ id, url: safeUrl(page.url()) })) };
    }
    if (command.command === 'stop') {
      await this.diagnostics('stop');
      this.stopped = true;
      await this.context.close();
      this.secrets.clear();
      return { status: 'stopped' };
    }
    if (command.command === 'newTab') {
      const page = await this.context.newPage();
      if (command.url) await page.goto(webUrl(command.url).href, { waitUntil: 'domcontentloaded' });
      return { tab: this.active };
    }
    if (command.command === 'useTab') {
      if (!this.pages.has(String(command.tab))) throw new Error('Unknown tab');
      this.active = String(command.tab);
      await this.page().bringToFront();
      return { tab: this.active };
    }
    const page = this.page();
    switch (command.command) {
      case 'closeTab': await page.close(); break;
      case 'goto': await page.goto(webUrl(command.url).href, { waitUntil: 'domcontentloaded' }); break;
      case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break;
      case 'snapshot': return this.snapshot(page);
      case 'diagnostics': return this.diagnostics(command.action);
      case 'login': return this.login(page, command.site);
      case 'scroll': await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(command.y) || 600))); break;
      case 'screenshot': {
        if (await page.locator('input[type="password"]').count()) throw new Error('Screenshots disabled on login pages');
        const directory = path.join(this.config.root, 'screenshots');
        await mkdir(directory, { recursive: true });
        const destination = path.join(directory, `${randomUUID()}.png`);
        await page.screenshot({ path: destination,
          mask: [page.locator('input, textarea, select, [contenteditable]')], fullPage: false });
        return { path: destination, warning: 'May contain private page content. Review locally before sharing.' };
      }
      default: {
        const target = this.locator(page, command);
        switch (command.command) {
          case 'click': await target.click(); break;
          case 'fill':
            await this.safeTarget(target);
            if (typeof command.text !== 'string' || command.text.length > 1000) throw new Error('Invalid text');
            await target.fill(command.text); break;
          case 'press':
            await this.safeTarget(target);
            if (!['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(command.key)) {
              throw new Error('Unsupported key');
            }
            await target.press(command.key); break;
          case 'select': await this.safeTarget(target); await target.selectOption(command.value); break;
          case 'check': await target.setChecked(command.checked ?? true); break;
          case 'wait': await target.waitFor({ state: 'visible' }); break;
          default: throw new Error('Unsupported action');
        }
      }
    }
    return { status: 'ok', url: safeUrl(page.url()) };
  }

  async run(command) {
    try {
      return redact({ ok: true, result: await this.dispatch(command) }, this.secrets);
    } catch {
      return { ok: false, error: 'Command failed or was blocked. Check session status, locator, site configuration, and local browser. Raw errors are suppressed to protect secrets.' };
    }
  }
}