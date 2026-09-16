import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settings, validateCommand } from './policy.mjs';
import { nativeDecoder, encodeNative } from './native-protocol.mjs';

const pending = new Map();
const sockets = new Set();
let server;
let ready = false;
let closing = false;

function shutdown() {
  if (closing) return;
  closing = true;
  for (const request of pending.values()) request.finish({ ok: false, error: 'Browser disconnected' });
  for (const socket of sockets) socket.destroy();
  server?.close();
  process.stdin.destroy();
}

function write(message) { process.stdout.write(encodeNative(message)); }

async function start() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf('--config');
  if (configIndex < 0) throw new Error('Missing connector config');
  const registration = JSON.parse(await readFile(args[configIndex + 1], 'utf8'));
  if (!/^[a-p]{32}$/.test(registration.extensionId ?? '')) throw new Error('Invalid extension registration');
  const origin = args.find(value => value.startsWith('chrome-extension://'));
  if (origin?.replace(/\/$/, '') !== `chrome-extension://${registration.extensionId}`) throw new Error('Unapproved extension');
  const config = settings(['--profile', registration.profile]);
  const decode = nativeDecoder(message => {
    if (message.type === 'ready') ready = true;
    else if (message.type === 'result') {
      const request = pending.get(message.id);
      if (request) request.finish(message.result?.ok === true
        ? message.result : { ok: false, error: 'Connector action blocked or failed. Check the shared tab and permissions.' });
    }
  });
  process.stdin.on('data', chunk => { try { decode(chunk); } catch { shutdown(); } });
  process.stdin.on('end', shutdown);
  process.stdin.on('error', shutdown);
  process.stdout.on('error', shutdown);
  let queue = Promise.resolve();
  server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(30000, () => socket.destroy());
    let raw = '';
    let received = false;
    socket.on('data', chunk => {
      if (received) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > 65536) { socket.destroy(); return; }
      if (!raw.includes('\n')) return;
      received = true;
      queue = queue.then(async () => {
        if (socket.destroyed || closing) return;
        let command;
        let response;
        try {
          command = validateCommand(JSON.parse(raw.slice(0, raw.indexOf('\n'))));
          if (!ready) throw new Error('Extension not ready');
          response = await new Promise(resolve => {
            const id = randomUUID();
            const timer = setTimeout(() => finish({ ok: false, error: 'Browser action timed out; inspect the page before retrying.' }), 20000);
            const finish = result => { clearTimeout(timer); pending.delete(id); resolve(result); };
            pending.set(id, { finish });
            write({ type: 'command', id, command });
          });
        } catch { response = { ok: false, error: 'Invalid command or unavailable connector' }; }
        socket.end(JSON.stringify(response), () => {
          if (command?.command === 'stop' && response.ok) shutdown();
        });
      }).catch(() => socket.destroy());
    });
  });
  server.on('error', () => { process.exitCode = 1; shutdown(); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.pipe, resolve);
  });
  write({ type: 'connected', profile: config.profile });
}

start().catch(() => {
  process.stderr.write('Session Browser connector unavailable. Check registration or another active connector.\n');
  process.exitCode = 1;
  shutdown();
});