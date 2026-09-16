export const hostName = 'com.session_browser.connector';
export const readCommands = new Set(['snapshot', 'wait']);
export const controlCommands = new Set(['click', 'fill', 'select', 'check', 'scroll', 'goto']);

export function originOf(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only ordinary HTTP(S) tabs can be shared');
  }
  return url.origin;
}

export function authorize(command, grant, tab) {
  if (!grant || grant.tab !== tab.id || originOf(tab.url) !== grant.origin) {
    throw new Error('Tab not shared for this origin');
  }
  if (!readCommands.has(command.command) && !controlCommands.has(command.command)) {
    throw new Error('Command unavailable in connector mode');
  }
  if (controlCommands.has(command.command) && !grant.control) throw new Error('Tab is read-only');
  if (command.command === 'goto' && originOf(command.url) !== grant.origin) {
    throw new Error('Share the destination origin manually');
  }
}

export function tabSummary(grant) {
  return { id: String(grant.tab), origin: grant.origin, access: grant.control ? 'control' : 'read' };
}