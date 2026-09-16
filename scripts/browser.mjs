import net from 'node:net';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { settings, validateCommand } from './policy.mjs';
import { BrowserSession } from './session.mjs';

const args = process.argv.slice(2);
const config = settings(args);
const operation = args[0];

async function send(command) {
  validateCommand(command);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.pipe);
    let response = '';
    socket.setTimeout(90000, () => socket.destroy(new Error('Session timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on('data', chunk => { response += chunk; });
    socket.on('error', reject);
    socket.on('end', () => {
      try { resolve(JSON.parse(response)); } catch { reject(new Error('Invalid response')); }
    });
  });
}

async function serve() {
  let session;
  let queue = Promise.resolve();
  const server = net.createServer(socket => {
    let input = '';
    let received = false;
    socket.setTimeout(95000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (received) return;
      input += chunk;
      if (Buffer.byteLength(input) > 65536) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      received = true;
      queue = queue.then(async () => {
        if (socket.destroyed) return;
        let result;
        try {
          const command = JSON.parse(input.slice(0, input.indexOf('\n')));
          result = session ? await session.run(command) : { ok: false, error: 'Browser starting' };
        } catch { result = { ok: false, error: 'Invalid command' }; }
        socket.end(JSON.stringify(result));
        if (session?.stopped) server.close();
      }).catch(() => socket.destroy());
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.pipe, resolve);
  });
  try {
    await mkdir(config.profilePath, { recursive: true });
    const context = await chromium.launchPersistentContext(config.profilePath, {
      chromiumSandbox: true,
      headless: config.headless, channel: config.channel, viewport: null, acceptDownloads: false, serviceWorkers: 'block',
    });
    session = new BrowserSession(context, config);
    if (!context.pages().length) await context.newPage();
    context.once('close', () => server.close());
    const stop = async () => { await context.close(); server.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.log(JSON.stringify({ ok: true, status: 'ready', mode: config.headless ? 'headless' : 'headed', profile: config.profile }));
  } catch {
    server.close();
    throw new Error('Browser launch failed');
  }
}

try {
  if (operation === 'serve') await serve();
  else if (operation === 'send') {
    let raw = args[1];
    if (raw === '-') {
      raw = '';
      for await (const chunk of process.stdin) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 65536) throw new Error('Command too large');
      }
    }
    const response = await send(JSON.parse(raw));
    console.log(JSON.stringify(response));
    if (!response.ok) process.exitCode = 1;
  } else throw new Error('Use serve or send');
} catch {
  console.error(JSON.stringify({ ok: false, error: 'Session unavailable or invalid command. Check setup, profile name, and whether that profile is already running.' }));
  process.exitCode = 1;
}