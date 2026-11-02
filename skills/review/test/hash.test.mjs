import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers.mjs';
import { hashFile, hashText } from '../lib/hash.mjs';

const expected = JSON.parse(fs.readFileSync(path.join(repoRoot, 'fixtures/hash/expected.json'), 'utf8'));

test('fixtures match expected.json', () => {
  for (const [name, hex] of Object.entries(expected)) assert.equal(hashFile(path.join(repoRoot, 'fixtures/hash', name)), hex);
});
test('latin1 and utf8 hash the same', () => {
  assert.equal(hashText(Buffer.from([0x68, 0xe9, 0x6c])), hashText(Buffer.from('hél', 'utf8')));
});
test('crlf is not normalised', () => assert.notEqual(hashText(Buffer.from('a\r\nb\r\n')), hashText(Buffer.from('a\nb\n'))));
test('a UTF-8 BOM is part of the text, as in Leaf', () => {
  assert.equal(hashText(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), hashText('﻿a'));
  assert.notEqual(hashText(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), hashText('a'));
});
