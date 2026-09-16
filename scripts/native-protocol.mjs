export const maxNativeBytes = 1024 * 1024 - 1;

export function encodeNative(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > maxNativeBytes) throw new Error('Native message too large');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export function nativeDecoder(onMessage) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE();
      if (!length || length > maxNativeBytes) throw new Error('Invalid native message size');
      if (buffer.length < length + 4) return;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      onMessage(message);
    }
  };
}