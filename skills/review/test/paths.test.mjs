import test from 'node:test';
import assert from 'node:assert/strict';
import { paths } from '../lib/paths.mjs';

test('names match the Swift side', () => {
  const p = paths('/w/docs/spec.md');
  assert.equal(p.folder, '/w/docs/.leaf');
  assert.equal(p.review, '/w/docs/.leaf/spec.md.review.json');
  assert.equal(p.comments, '/w/docs/.leaf/spec.md.comments.json');
  assert.equal(p.lock, '/w/docs/.leaf/spec.md.lock');
  assert.equal(p.endingMarker, '/w/docs/.leaf/spec.md.review.ending.json');
  assert.equal(p.staged('7f3c', 1), '/w/docs/.leaf/spec.md.7f3c.r1.revision.md');
  assert.equal(p.replies('7f3c', 1), '/w/docs/.leaf/spec.md.7f3c.r1.replies.json');
  assert.equal(p.backup(1), '/w/docs/.leaf/spec.md.backup.1.md');
  assert.equal(p.archive('7f3c', 0), '/w/docs/.leaf/spec.md.comments.7f3c.json');
  assert.equal(p.archive('7f3c', 2), '/w/docs/.leaf/spec.md.comments.7f3c-3.json');
});
