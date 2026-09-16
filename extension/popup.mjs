import { originOf } from './policy.mjs';

let currentTab;
const error = document.getElementById('error');
const share = document.getElementById('share');
document.getElementById('extension-id').textContent = chrome.runtime.id;

async function refresh(action = 'view', extra = {}) {
  error.textContent = '';
  try {
    const response = await chrome.runtime.sendMessage({ action, ...extra });
    if (!response?.ok) throw new Error(response?.error || 'Connector unavailable');
    document.getElementById('connection').textContent = response.connection;
    document.getElementById('profile').textContent = response.profile ? `CLI profile: ${response.profile}` : '';
    const list = document.getElementById('tabs');
    list.replaceChildren();
    for (const tab of response.tabs) {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${tab.origin} (${tab.access})`;
      const revoke = document.createElement('button');
      revoke.className = 'secondary';
      revoke.textContent = 'Stop Sharing';
      revoke.addEventListener('click', () => refresh('revoke', { tab: Number(tab.id) }));
      row.append(label, revoke); list.append(row);
    }
  } catch (failure) { error.textContent = failure.message; }
}

share.addEventListener('click', async () => {
  if (!currentTab) return;
  share.disabled = true;
  await refresh('share', { tab: currentTab.id, control: document.getElementById('control').checked });
  share.disabled = false;
});
document.getElementById('disconnect').addEventListener('click', () => refresh('disconnect'));
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message.type === 'connector-state') void refresh();
});
try {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (currentTab.incognito) throw new Error('Private tab');
  document.getElementById('origin').textContent = originOf(currentTab.url);
} catch { currentTab = null; share.disabled = true; }
await refresh();