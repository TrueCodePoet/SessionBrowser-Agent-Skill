import { Connector } from './controller.mjs';
import { hostName } from './policy.mjs';

const connector = new Connector(chrome);
let port = null;
let connection = 'disconnected';
let profile = null;
let queue = Promise.resolve();

function notify() {
  void chrome.runtime.sendMessage({ type: 'connector-state' }).catch(() => {});
}

function connect() {
  if (port) return;
  connection = 'connecting';
  const current = chrome.runtime.connectNative(hostName);
  port = current;
  current.onMessage.addListener(message => {
    if (message.type === 'connected') {
      connection = 'connected';
      profile = message.profile;
      notify();
    } else if (message.type === 'command' && typeof message.id === 'string' && message.id.length <= 64) {
      queue = queue.then(async () => {
        if (port !== current) return;
        const result = await connector.run(message.command);
        if (port === current) current.postMessage({ type: 'result', id: message.id, result });
      }).catch(() => {});
    }
  });
  current.onDisconnect.addListener(() => {
    const failed = !!chrome.runtime.lastError;
    if (port !== current) return;
    port = null;
    profile = null;
    connection = failed ? 'host unavailable' : 'disconnected';
    void connector.clear().then(notify);
  });
  current.postMessage({ type: 'ready' });
}

chrome.tabs.onRemoved.addListener(tabId => { void connector.revoke(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && connector.grants.has(tabId)) void connector.current(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) return;
  (async () => {
    if (message.action === 'share') {
      connect();
      await connector.share(message.tab, message.control);
    } else if (message.action === 'revoke') await connector.revoke(message.tab);
    else if (message.action === 'disconnect') {
      await connector.clear();
      const previous = port;
      port = null; profile = null; connection = 'disconnected';
      previous?.disconnect();
    } else if (message.action !== 'view') throw new Error('Unsupported popup action');
    return { ok: true, connection, profile, tabs: (await connector.run({ command: 'tabs' })).result.tabs };
  })().then(respond, () => respond({ ok: false, error: 'Cannot share this tab. Check the local host installation and use a normal HTTP(S) tab.' }));
  return true;
});