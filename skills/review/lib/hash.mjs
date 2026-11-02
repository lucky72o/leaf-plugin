// The review protocol's text hash, identical to Leaf's TextHash: SHA-256 hex of the
// text decoded as UTF-8 (else Latin-1) and re-encoded as UTF-8; line endings untouched.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

export function decodeText(buffer) {
  try {
    // ignoreBOM keeps U+FEFF in the text, as Leaf's decoder does.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return buffer.toString('latin1');
  }
}

export function hashText(buffer) {
  const text = typeof buffer === 'string' ? buffer : decodeText(buffer);
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

export function hashFile(file) {
  return hashText(fs.readFileSync(file));
}
