import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers.mjs';
import { renderComments } from '../lib/render.mjs';

const example = [
  { id: 'c1', round: 1, kind: 'span', quote: 'The host loads every plugin at startup', prefix: 'folder with a manifest. ', suffix: ' and keeps them resident', heading: 'Goals', line: 14, text: 'Lazy load instead. Startup time is the whole point of this.' },
  { id: 'c2', round: 1, kind: 'point', quote: '', prefix: 'a coherent set.', suffix: '', heading: 'Goals', line: 16, text: 'Add an example of a collection here.' },
  { id: 'c3', round: 1, kind: 'general', text: 'Too long for a v1.' },
];

test('renders the spec example', () => {
  const expected = fs.readFileSync(path.join(repoRoot, 'fixtures/review/comments-example.md'), 'utf8');
  assert.equal(renderComments({ comments: example, round: 1, fileName: 'docs/spec.md', reviewId: '7f3c' }), expected);
});
test('without review id', () => assert.ok(renderComments({ comments: example, round: 1, fileName: 'docs/spec.md' }).startsWith('## Review round 1 of docs/spec.md (3 comments)\n')));
test('multi-line text indented', () => assert.ok(renderComments({ comments: [{ id: 'c1', kind: 'general', text: 'a\nb' }], round: 2, fileName: 'x.md' }).includes('1. [c1] Whole document:\n   a\n   b\n')));
test('missing heading and line omitted', () => assert.ok(renderComments({ comments: [{ id: 'c4', kind: 'span', quote: 'abc', heading: '', line: null, text: 't' }], round: 1, fileName: 'x.md' }).includes('1. [c4] On "abc":\n   t\n')));
