import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLock, HOLDER_SCRIPT } from '../lib/lock.mjs';

function tmpLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-lock-'));
  return path.join(dir, 'doc.md.lock');
}

// A foreign holder: the same perl helper in another process, never released by us.
function foreignHolder(file) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/perl', ['-e', HOLDER_SCRIPT, file, '2000'], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdout.once('data', () => resolve(child));
  });
}

test('acquire and release', async () => {
  const file = tmpLock();
  const release = await acquireLock(file);
  assert.ok(fs.existsSync(file));
  release();
  (await acquireLock(file, { timeoutMs: 500 }))();
});
test('busy lock times out, then succeeds after release', async () => {
  const file = tmpLock();
  const release = await acquireLock(file);
  await assert.rejects(acquireLock(file, { timeoutMs: 200 }), /busy/);
  release();
  (await acquireLock(file, { timeoutMs: 500 }))();
});
test('a holder that dies releases the lock by itself', async () => {
  const file = tmpLock();
  const holder = await foreignHolder(file);
  await assert.rejects(acquireLock(file, { timeoutMs: 200 }), /busy/);
  holder.kill('SIGKILL');
  await new Promise(r => holder.once('exit', r));
  (await acquireLock(file, { timeoutMs: 1000 }))();
});
test('a live holder is never evicted, however old the lock file is', async () => {
  const file = tmpLock();
  const holder = await foreignHolder(file);
  const old = new Date(Date.now() - 600000);
  fs.utimesSync(file, old, old);
  await assert.rejects(acquireLock(file, { timeoutMs: 300 }), /busy/);
  holder.stdin.end();
  await new Promise(r => holder.once('exit', r));
});
test('release twice is harmless', async () => {
  const file = tmpLock();
  const release = await acquireLock(file);
  release(); release();
  (await acquireLock(file, { timeoutMs: 500 }))();
});
