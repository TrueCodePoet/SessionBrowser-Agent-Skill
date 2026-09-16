export async function pageAction({ command, expectedOrigin }) {
  if (location.origin !== expectedOrigin) throw new Error('Origin changed');
  const visible = element => !!element.getClientRects().length &&
    getComputedStyle(element).visibility === 'visible' && !element.closest('[hidden], [aria-hidden="true"]');
  const label = element => (element.labels?.[0]?.innerText || element.getAttribute('aria-label') ||
    element.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ') ||
    (element.matches('a, button, [role="button"]') ? element.innerText : '') || '').trim().slice(0, 240);
  const role = element => element.getAttribute('role') ||
    (element.matches('button, input[type="submit"], input[type="button"]') ? 'button' :
      element.matches('a[href]') ? 'link' : element.matches('input[type="checkbox"]') ? 'checkbox' :
        element.matches('select') ? 'combobox' : element.matches('input, textarea') ? 'textbox' : '');
  const locate = () => {
    let matches;
    if (typeof command.selector === 'string' && command.selector.length <= 500 &&
      command.selector.split(',').length <= 10) {
      matches = [...document.querySelectorAll(command.selector)];
    } else {
      matches = [...document.querySelectorAll('a, button, input, textarea, select, [role]')]
        .filter(element => command.role ? role(element) === command.role && label(element) === command.name :
          typeof command.label === 'string' && label(element) === command.label);
    }
    matches = matches.filter(visible);
    if (matches.length !== 1) throw new Error('Locator must match one visible element');
    return matches[0];
  };
  const protect = element => {
    const description = ['type', 'name', 'id', 'autocomplete', 'aria-label', 'placeholder']
      .map(attribute => element.getAttribute(attribute) || '').join(' ');
    if (/password|passwd|passcode|secret|token|username|user.?name|email|one.?time|otp|\bpin\b|credit.?card|cc-|cvv|cvc/i.test(description) ||
      element.closest('form')?.querySelector('input[type="password"]')) throw new Error('Protected field');
  };
  if (command.command === 'snapshot') {
    const text = [];
    let length = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && length < 12000) {
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.closest('script, style, noscript, input, textarea, select, [contenteditable], iframe') || !visible(parent)) continue;
      const part = walker.currentNode.textContent.replace(/\s+/g, ' ').trim();
      if (part) { text.push(part); length += part.length + 1; }
    }
    const controls = [...document.querySelectorAll('a, button, input, textarea, select, [role="button"]')]
      .filter(visible).slice(0, 100).map(element => ({ role: role(element), label: label(element),
        tag: element.tagName.toLowerCase(), type: element.getAttribute('type') }));
    return { text: text.join(' ').slice(0, 12000), controls };
  }
  if (command.command === 'goto') {
    const destination = new URL(command.url);
    if (destination.origin !== expectedOrigin || destination.username || destination.password) throw new Error('Invalid destination');
    location.assign(destination.href);
    return { status: 'navigation_started' };
  }
  if (command.command === 'scroll') {
    scrollBy(0, Math.max(-2000, Math.min(2000, Number(command.y) || 600)));
    return { status: 'ok' };
  }
  if (command.command === 'wait') {
    await new Promise((resolve, reject) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Not visible')); }, 8000);
      function check() {
        try {
          if (location.origin !== expectedOrigin) throw new Error('Origin changed');
          locate();
          clearTimeout(timer); observer.disconnect(); resolve();
        } catch {}
      }
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      check();
    });
    return { status: 'visible' };
  }
  const element = locate();
  if (command.command === 'click') element.click();
  else if (command.command === 'fill') {
    protect(element);
    if (typeof command.text !== 'string' || command.text.length > 1000 ||
      !element.matches('input[type="text"], input[type="search"], input:not([type]), textarea')) throw new Error('Unsupported field');
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, command.text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (command.command === 'select') {
    protect(element);
    if (!(element instanceof HTMLSelectElement) || typeof command.value !== 'string' ||
      ![...element.options].some(option => option.value === command.value)) throw new Error('Invalid option');
    element.value = command.value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (command.command === 'check') {
    if (!element.matches('input[type="checkbox"], input[type="radio"]') ||
      (command.checked !== undefined && typeof command.checked !== 'boolean')) throw new Error('Invalid checkbox');
    if (element.checked !== (command.checked ?? true)) element.click();
  } else throw new Error('Unsupported action');
  return { status: 'ok' };
}