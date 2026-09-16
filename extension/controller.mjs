import { authorize, originOf, tabSummary } from './policy.mjs';
import { pageAction } from './page-action.mjs';

export class Connector {
  constructor(api) {
    this.api = api;
    this.grants = new Map();
    this.active = null;
  }

  async share(tabId, control = false) {
    const tab = await this.api.tabs.get(tabId);
    if (tab.incognito) throw new Error('Private tabs are not supported');
    const grant = { tab: tab.id, origin: originOf(tab.url), control: control === true };
    this.grants.set(tab.id, grant);
    this.active = tab.id;
    await this.api.action.setBadgeText({ tabId, text: grant.control ? 'ACT' : 'READ' });
    return tabSummary(grant);
  }

  async revoke(tabId) {
    this.grants.delete(tabId);
    if (this.active === tabId) this.active = this.grants.keys().next().value ?? null;
    await this.api.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }

  async clear() {
    for (const tabId of [...this.grants.keys()]) await this.revoke(tabId);
  }

  async current(tabId) {
    const grant = this.grants.get(tabId);
    if (!grant) throw new Error('Tab not shared');
    try {
      const tab = await this.api.tabs.get(tabId);
      if (tab.incognito || originOf(tab.url) !== grant.origin) throw new Error('Origin changed');
      return tab;
    } catch {
      await this.revoke(tabId);
      throw new Error('Tab sharing ended');
    }
  }

  async run(command) {
    try {
      if (command.command === 'status' || command.command === 'tabs') {
        for (const tabId of [...this.grants.keys()]) await this.current(tabId).catch(() => {});
        return { ok: true, result: { mode: 'connected', activeTab: this.active === null ? null : String(this.active),
          tabs: [...this.grants.values()].map(tabSummary) } };
      }
      if (command.command === 'stop') { await this.clear(); return { ok: true, result: { status: 'disconnected' } }; }
      const tabId = command.command === 'useTab' ? Number(command.tab) : this.active;
      const tab = await this.current(tabId);
      if (command.command === 'useTab') {
        this.active = tabId;
        await this.api.tabs.update(tabId, { active: true });
        await this.api.windows.update(tab.windowId, { focused: true });
        return { ok: true, result: { tab: String(tabId) } };
      }
      const grant = this.grants.get(tabId);
      authorize(command, grant, tab);
      const results = await this.api.scripting.executeScript({ target: { tabId, frameIds: [0] },
        world: 'ISOLATED', func: pageAction, args: [{ command, expectedOrigin: grant.origin }] });
      if (this.grants.get(tabId) !== grant) throw new Error('Sharing revoked');
      return { ok: true, result: results[0]?.result ?? { status: 'navigation_started' } };
    } catch {
      return { ok: false, error: 'Action blocked or failed. Check sharing, origin, control permission, and locator. Credentials must be entered manually.' };
    }
  }
}