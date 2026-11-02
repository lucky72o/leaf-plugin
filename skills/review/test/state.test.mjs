import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, wait, publish, done, restore } from '../lib/state.mjs';
import { paths } from '../lib/paths.mjs';
import { hashFile, hashText } from '../lib/hash.mjs';
import { writeJSONAtomic, readJSON } from '../lib/files.mjs';

const TEXT = '# Doc\n\nFirst paragraph.\n\nSecond paragraph.\n';

function makeDoc(text = TEXT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-state-'));
  const doc = path.join(dir, 'doc.md');
  fs.writeFileSync(doc, text);
  return doc;
}

// Writes the comments file the way Leaf does for a round.
function leafComments(doc, id, round, { status = 'draft', comments = [], enteredRounds = [round], submittedTextHash = null } = {}) {
  const p = paths(doc);
  fs.mkdirSync(p.folder, { recursive: true });
  writeJSONAtomic(p.comments, { version: 1, reviewId: id, file: doc, round, status, submittedAt: status === 'submitted' ? 't' : null, submittedTextHash, enteredRounds, comments });
}

const comment = (id, round, text = 'note') => ({ id, round, kind: 'general', text });

async function started(doc) {
  const r = await start(doc, undefined, { owner: 'test' });
  assert.equal(r.action, 'new');
  return r.reviewId;
}

async function submittedRound1(doc) {
  const id = await started(doc);
  leafComments(doc, id, 1, { status: 'submitted', comments: [comment('c1', 1)], submittedTextHash: hashFile(doc) });
  return id;
}

function stageAndReply(doc, id, round, text, replies = [{ commentId: 'c1', text: 'done' }]) {
  const p = paths(doc);
  fs.writeFileSync(p.staged(id, round), text);
  writeJSONAtomic(p.replies(id, round), { reviewId: id, round, replies });
}

test('new review writes round 1 with owner and hash', async () => {
  const doc = makeDoc();
  const r = await start(doc, undefined, { owner: 'session-a' });
  assert.equal(r.action, 'new');
  assert.equal(r.round, 1);
  const review = readJSON(paths(doc).review);
  assert.equal(review.reviewId, r.reviewId);
  assert.equal(review.owner, 'session-a');
  assert.equal(review.textHash, hashText(TEXT));
  assert.equal(review.snapshot, TEXT);
  assert.equal(review.file, doc);
  assert.equal(review.previousSnapshot, undefined);
});

test('start without id on an active review is refused with id and owner', async () => {
  const doc = makeDoc();
  const id = await started(doc);
  const r = await start(doc, undefined, { owner: 'other' });
  assert.equal(r.action, 'refused');
  assert.equal(r.reviewId, id);
  assert.equal(r.owner, 'test');
  assert.equal(r.round, 1);
  const r2 = await start(doc, 'wrong-id', { owner: 'other' });
  assert.equal(r2.action, 'refused');
});

test('resume with id writes nothing', async () => {
  const doc = makeDoc();
  const id = await started(doc);
  const before = fs.readFileSync(paths(doc).review, 'utf8');
  const r = await start(doc, id, { owner: 'test' });
  assert.equal(r.action, 'resume');
  assert.equal(r.round, 1);
  assert.equal(fs.readFileSync(paths(doc).review, 'utf8'), before);
});

test('submitted zero comments is approved and ended', async () => {
  const doc = makeDoc();
  const id = await started(doc);
  leafComments(doc, id, 1, { status: 'submitted', comments: [], submittedTextHash: hashFile(doc) });
  const r = await start(doc, id, { owner: 'test' });
  assert.equal(r.action, 'approved');
  const p = paths(doc);
  assert.ok(!fs.existsSync(p.review));
  assert.ok(fs.existsSync(p.archive(id, 0)));
  assert.ok(!fs.existsSync(p.comments));
});

test('submitted comments gives needs-replies with markdown', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const r = await start(doc, id, { owner: 'test' });
  assert.equal(r.action, 'needs-replies');
  assert.equal(r.round, 1);
  assert.ok(r.markdown.includes('[c1]'));
  assert.equal(r.submittedTextHash, hashFile(doc));
  assert.equal(r.comments.length, 1);
});

test('publish writes N+1, backup, moves staged, deletes replies', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const p = paths(doc);
  stageAndReply(doc, id, 1, TEXT + '\nAdded.\n');
  const r = await publish(doc, id, 1, {});
  assert.equal(r.result, 'published');
  assert.equal(r.round, 2);
  const review = readJSON(p.review);
  assert.equal(review.round, 2);
  assert.equal(review.previousSnapshot, TEXT);
  assert.equal(review.previousTextHash, hashText(TEXT));
  assert.equal(review.snapshot, TEXT + '\nAdded.\n');
  assert.equal(review.textHash, hashText(TEXT + '\nAdded.\n'));
  assert.deepEqual(review.replies, [{ commentId: 'c1', text: 'done' }]);
  assert.equal(fs.readFileSync(doc, 'utf8'), TEXT + '\nAdded.\n');
  assert.equal(fs.readFileSync(p.backup(1), 'utf8'), TEXT);
  assert.ok(!fs.existsSync(p.staged(id, 1)));
  assert.ok(!fs.existsSync(p.replies(id, 1)));
});

test('publish with changed document is refused and writes nothing', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  stageAndReply(doc, id, 1, 'revised');
  fs.writeFileSync(doc, TEXT + 'edited after submit\n');
  const r = await publish(doc, id, 1, {});
  assert.equal(r.result, 'changed');
  assert.equal(r.expected, hashText(TEXT));
  assert.equal(r.actual, hashText(TEXT + 'edited after submit\n'));
  assert.equal(readJSON(paths(doc).review).round, 1);
  assert.equal(fs.readFileSync(doc, 'utf8'), TEXT + 'edited after submit\n');
  assert.ok(fs.existsSync(paths(doc).staged(id, 1)));
});

test('publish with --expect current hash succeeds', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  stageAndReply(doc, id, 1, 'revised');
  fs.writeFileSync(doc, TEXT + 'edited after submit\n');
  const r = await publish(doc, id, 1, { expect: hashFile(doc) });
  assert.equal(r.result, 'published');
  assert.equal(fs.readFileSync(doc, 'utf8'), 'revised');
});

test('publish with missing reply is incomplete', async () => {
  const doc = makeDoc();
  const id = await started(doc);
  leafComments(doc, id, 1, { status: 'submitted', comments: [comment('c1', 1), comment('c2', 1)], submittedTextHash: hashFile(doc) });
  stageAndReply(doc, id, 1, 'revised', [{ commentId: 'c1', text: 'done' }]);
  const r = await publish(doc, id, 1, {});
  assert.equal(r.result, 'incomplete');
  assert.deepEqual(r.missing, ['c2']);
  assert.equal(fs.readFileSync(doc, 'utf8'), TEXT);
});

test('publish without a staged file is no-revision', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const r = await publish(doc, id, 1, {});
  assert.equal(r.result, 'no-revision');
});

test('publish after done is cancelled', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  stageAndReply(doc, id, 1, 'revised');
  await done(doc, id, {});
  const r = await publish(doc, id, 1, {});
  assert.equal(r.result, 'cancelled');
  assert.equal(fs.readFileSync(doc, 'utf8'), TEXT);
});

test('publish with stale round is stale', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  stageAndReply(doc, id, 1, 'revised');
  assert.equal((await publish(doc, id, 1, {})).result, 'published');
  stageAndReply(doc, id, 1, 'revised again');
  const r = await publish(doc, id, 1, {});
  assert.equal(r.result, 'stale');
  assert.equal(fs.readFileSync(doc, 'utf8'), 'revised');
});

test('publishInterruptedAfterReviewFile is finished by start', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const p = paths(doc);
  stageAndReply(doc, id, 1, 'revised');
  const r = await publish(doc, id, 1, { abortAfter: 1 });
  assert.equal(r.result, 'aborted');
  assert.equal(readJSON(p.review).round, 2);
  assert.equal(fs.readFileSync(doc, 'utf8'), TEXT);
  const s = await start(doc, id, { owner: 'test' });
  assert.equal(s.action, 'resume');
  assert.equal(s.round, 2);
  assert.equal(fs.readFileSync(doc, 'utf8'), 'revised');
  assert.equal(fs.readFileSync(p.backup(1), 'utf8'), TEXT);
  assert.ok(!fs.existsSync(p.staged(id, 1)));
  assert.ok(!fs.existsSync(p.replies(id, 1)));
});

test('publish interrupted after backup is finished by start', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  stageAndReply(doc, id, 1, 'revised');
  assert.equal((await publish(doc, id, 1, { abortAfter: 2 })).result, 'aborted');
  const s = await start(doc, id, { owner: 'test' });
  assert.equal(s.action, 'resume');
  assert.equal(s.round, 2);
  assert.equal(fs.readFileSync(doc, 'utf8'), 'revised');
});

test('done interrupted after archive is finished by start', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const p = paths(doc);
  stageAndReply(doc, id, 1, 'revised');
  const r = await done(doc, id, { abortAfter: 2 });
  assert.equal(r.result, 'aborted');
  assert.ok(fs.existsSync(p.endingMarker));
  assert.ok(fs.existsSync(p.staged(id, 1)));
  const s = await start(doc, undefined, { owner: 'next' });
  assert.equal(s.action, 'new');
  assert.notEqual(s.reviewId, id);
  assert.ok(!fs.existsSync(p.endingMarker));
  assert.ok(!fs.existsSync(p.staged(id, 1)));
  assert.ok(fs.existsSync(p.archive(id, 0)));
});

test('done interrupted after the marker rename is finished by start', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const p = paths(doc);
  assert.equal((await done(doc, id, { abortAfter: 1 })).result, 'aborted');
  assert.ok(fs.existsSync(p.comments));
  const s = await start(doc, undefined, { owner: 'next' });
  assert.equal(s.action, 'new');
  assert.ok(fs.existsSync(p.archive(id, 0)));
  assert.ok(!fs.existsSync(p.endingMarker));
});

test('done twice is harmless and archives never overwrite', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const p = paths(doc);
  assert.equal((await done(doc, id, {})).result, 'ended');
  assert.equal((await done(doc, id, {})).result, 'nothing');
  assert.equal((await done(doc, undefined, {})).result, 'nothing');
  // A second review with the same id cannot happen, but an archive name clash must not overwrite.
  fs.writeFileSync(p.comments, '{"reviewId":"' + id + '","round":1,"status":"draft","comments":[],"enteredRounds":[1]}');
  fs.writeFileSync(p.review, JSON.stringify({ version: 1, reviewId: id, file: doc, round: 1, startedAt: 't', owner: 'o', textHash: hashFile(doc), snapshot: TEXT }));
  await done(doc, id, {});
  assert.ok(fs.existsSync(p.archive(id, 0)) && fs.existsSync(p.archive(id, 1)));
});

test('done with another id is refused', async () => {
  const doc = makeDoc();
  await submittedRound1(doc);
  const r = await done(doc, 'other', {});
  assert.equal(r.result, 'refused');
  assert.ok(fs.existsSync(paths(doc).review));
});

test('wait returns submitted markdown', async () => {
  const doc = makeDoc();
  const id = await started(doc);
  setTimeout(() => leafComments(doc, id, 1, { status: 'submitted', comments: [comment('c1', 1, 'Shorter please')], submittedTextHash: hashFile(doc) }), 300);
  const r = await wait(doc, id, 1, { timeoutMs: 5000, intervalMs: 50 });
  assert.equal(r.code, 0);
  assert.equal(r.status, 'submitted');
  assert.equal(r.count, 1);
  assert.ok(r.markdown.includes('Shorter please'));
  assert.equal(r.submittedTextHash, hashFile(doc));
});

test('wait returns 3 when review file disappears', async () => {
  const doc = makeDoc();
  const id = await started(doc);
  setTimeout(() => fs.rmSync(paths(doc).review), 200);
  const r = await wait(doc, id, 1, { timeoutMs: 5000, intervalMs: 50 });
  assert.equal(r.code, 3);
});

test('wait returns 2 on timeout and leaves files in place', async () => {
  const doc = makeDoc();
  const id = await started(doc);
  const r = await wait(doc, id, 1, { timeoutMs: 200, intervalMs: 50 });
  assert.equal(r.code, 2);
  assert.ok(fs.existsSync(paths(doc).review));
});

test('wait ignores a comments file with another review id', async () => {
  const doc = makeDoc();
  const id = await started(doc);
  leafComments(doc, 'stale-id', 1, { status: 'submitted', comments: [comment('c1', 1)], submittedTextHash: hashFile(doc) });
  const r = await wait(doc, id, 1, { timeoutMs: 300, intervalMs: 50 });
  assert.equal(r.code, 2);
});

test('behind comments file counts as no comments for the round', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  stageAndReply(doc, id, 1, 'revised');
  assert.equal((await publish(doc, id, 1, {})).result, 'published');
  // Leaf has not written since the advance: the comments file is still round 1 submitted.
  const s = await start(doc, id, { owner: 'test' });
  assert.equal(s.action, 'resume');
  assert.equal(s.round, 2);
  const w = await wait(doc, id, 2, { timeoutMs: 300, intervalMs: 50 });
  assert.equal(w.code, 2);
});

test('gitignore gets .leaf/ once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-git-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
  fs.mkdirSync(path.join(dir, 'docs'));
  const doc = path.join(dir, 'docs', 'spec.md');
  fs.writeFileSync(doc, TEXT);
  const id = await started(doc);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'build/\n.leaf/\n');
  await done(doc, id, {});
  await started(doc);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'build/\n.leaf/\n');
});

// Round 1 review findings.
test('interrupted publish is not finished for a caller without the id', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  stageAndReply(doc, id, 1, 'revised');
  assert.equal((await publish(doc, id, 1, { abortAfter: 2 })).result, 'aborted');
  const r = await start(doc, undefined, { owner: 'other' });
  assert.equal(r.action, 'refused');
  assert.equal(fs.readFileSync(doc, 'utf8'), TEXT);
  assert.ok(fs.existsSync(paths(doc).staged(id, 1)));
});

test('interrupted publish is refused when the document changed in between', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const p = paths(doc);
  for (const k of [1, 2]) {
    stageAndReply(doc, id, 1, 'revised');
    // Reset to a submitted round 1 for the second iteration.
    if (k === 2) {
      writeJSONAtomic(p.review, { ...readJSON(p.review), round: 1, textHash: hashText(TEXT), snapshot: TEXT, previousSnapshot: undefined, previousTextHash: undefined, replies: undefined, baseTextHash: undefined });
      fs.writeFileSync(doc, TEXT);
      leafComments(doc, id, 1, { status: 'submitted', comments: [comment('c1', 1)], submittedTextHash: hashText(TEXT) });
    }
    assert.equal((await publish(doc, id, 1, { abortAfter: k })).result, 'aborted');
    fs.writeFileSync(doc, TEXT + 'saved while publishing\n');
    const r = await start(doc, id, { owner: 'test' });
    assert.equal(r.action, 'changed', 'abort after ' + k);
    assert.match(r.message, /Ask the user whether to redo/);
    assert.equal(fs.readFileSync(doc, 'utf8'), TEXT + 'saved while publishing\n');
    assert.ok(fs.existsSync(p.staged(id, 1)));
    assert.equal(readJSON(p.review).round, 1);
    // The normal recovery now works: publish again against the current text.
    const again = await publish(doc, id, 1, { expect: r.actual });
    assert.equal(again.result, 'published', 'abort after ' + k);
    assert.equal(fs.readFileSync(doc, 'utf8'), 'revised');
  }
});

test('review file N+1 records the base hash publish verified', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  stageAndReply(doc, id, 1, 'revised');
  await publish(doc, id, 1, {});
  assert.equal(readJSON(paths(doc).review).baseTextHash, hashText(TEXT));
});

// Round 2 review findings.
test('interrupted publish already entered by Leaf is finished without rewinding', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const p = paths(doc);
  stageAndReply(doc, id, 1, TEXT);   // an unchanged revision: Leaf can enter round 2 before the move
  assert.equal((await publish(doc, id, 1, { abortAfter: 1 })).result, 'aborted');
  leafComments(doc, id, 2, { status: 'draft', comments: [comment('c1', 1), comment('c2', 2)], enteredRounds: [1, 2] });
  fs.writeFileSync(doc, TEXT + 'owner edit after entering\n');
  const s = await start(doc, id, { owner: 'test' });
  assert.equal(s.action, 'resume');
  assert.equal(s.round, 2);
  assert.equal(readJSON(p.review).round, 2);
  assert.equal(fs.readFileSync(doc, 'utf8'), TEXT + 'owner edit after entering\n');
  assert.ok(!fs.existsSync(p.staged(id, 1)));
  assert.ok(!fs.existsSync(p.replies(id, 1)));
});

test('a publish retried after a conflict backs up the text it replaces', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const p = paths(doc);
  stageAndReply(doc, id, 1, 'revised');
  assert.equal((await publish(doc, id, 1, { abortAfter: 2 })).result, 'aborted');
  fs.writeFileSync(doc, TEXT + 'owner text\n');
  const r = await start(doc, id, { owner: 'test' });
  assert.equal(r.action, 'changed');
  assert.equal((await publish(doc, id, 1, { expect: r.actual })).result, 'published');
  const backups = fs.readdirSync(p.folder).filter(e => e.includes('.backup.1')).map(e => fs.readFileSync(path.join(p.folder, e), 'utf8'));
  assert.ok(backups.includes(TEXT + 'owner text\n'), 'owner text must be in a backup');
  assert.ok(backups.includes(TEXT), 'the earlier backup is kept too');
});

// Round 3 review findings.
test('recovery does not trust a partial backup', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const p = paths(doc);
  stageAndReply(doc, id, 1, 'revised');
  assert.equal((await publish(doc, id, 1, { abortAfter: 1 })).result, 'aborted');
  fs.writeFileSync(p.backup(1), TEXT.slice(0, 5));   // a copy that died half way
  const s = await start(doc, id, { owner: 'test' });
  assert.equal(s.action, 'resume');
  assert.equal(fs.readFileSync(doc, 'utf8'), 'revised');
  const backups = fs.readdirSync(p.folder).filter(e => e.includes('.backup.1')).map(e => fs.readFileSync(path.join(p.folder, e), 'utf8'));
  assert.ok(backups.includes(TEXT), 'the full text must be in a backup: ' + JSON.stringify(backups));
});

test('backups are written atomically', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  stageAndReply(doc, id, 1, 'revised');
  await publish(doc, id, 1, {});
  assert.deepEqual(fs.readdirSync(paths(doc).folder).filter(e => e.includes('.tmp')), []);
});

test('conflict recovery at round 2 keeps round 2 replies and previous snapshot', async () => {
  const doc = makeDoc();
  const id = await submittedRound1(doc);
  const p = paths(doc);
  stageAndReply(doc, id, 1, 'second text');
  assert.equal((await publish(doc, id, 1, {})).result, 'published');
  const round2 = readJSON(p.review);
  leafComments(doc, id, 2, { status: 'submitted', comments: [comment('c1', 1), comment('c2', 2)], enteredRounds: [1, 2], submittedTextHash: hashText('second text') });
  stageAndReply(doc, id, 2, 'third text', [{ commentId: 'c2', text: 'done' }]);
  assert.equal((await publish(doc, id, 2, { abortAfter: 1 })).result, 'aborted');
  fs.writeFileSync(doc, 'second text with an owner edit');
  const s = await start(doc, id, { owner: 'test' });
  assert.equal(s.action, 'changed');
  const restored = readJSON(p.review);
  assert.equal(restored.round, 2);
  assert.deepEqual(restored.replies, round2.replies);
  assert.equal(restored.previousSnapshot, round2.previousSnapshot);
  assert.equal(restored.previousTextHash, round2.previousTextHash);
  assert.equal(restored.baseTextHash, round2.baseTextHash);
});

// Unsubmitted comments left behind by End review are reported by start and can be restored.
const ARCHIVE_ID = '11111111-2222-4333-8444-555555555555';
function archiveOf(doc, id, { status = 'draft', round = 1, comments = [], attempt = 0 } = {}) {
  const p = paths(doc);
  fs.mkdirSync(p.folder, { recursive: true });
  writeJSONAtomic(p.archive(id, attempt), { version: 1, reviewId: id, file: doc, round, status, enteredRounds: [round], lastCommentNumber: comments.length, comments });
  return p.archive(id, attempt);
}

test('start reports an archive with unsubmitted comments', async () => {
  const doc = makeDoc();
  const file = archiveOf(doc, ARCHIVE_ID, { comments: [{ ...comment('c1', 1, 'fix this'), heading: 'Doc', line: 3, quote: 'First' }], attempt: 1 });
  const r = await start(doc, undefined, { owner: 'test' });
  assert.equal(r.action, 'new');
  assert.ok(file.endsWith('-2.json'));
  assert.deepEqual(r.unsubmitted, [{ archive: file, reviewId: ARCHIVE_ID, round: 1, count: 1,
                                     comments: [{ id: 'c1', heading: 'Doc', line: 3, quote: 'First', text: 'fix this' }] }]);
});

test('start says nothing about submitted or empty archives', async () => {
  const doc = makeDoc();
  archiveOf(doc, ARCHIVE_ID.replace('1111', 'aaaa'), { status: 'submitted', comments: [comment('c1', 1)] });
  archiveOf(doc, ARCHIVE_ID.replace('1111', 'bbbb'), { comments: [] });
  archiveOf(doc, ARCHIVE_ID.replace('1111', 'cccc'), { round: 2, comments: [comment('c1', 1)] });
  const r = await start(doc, undefined, { owner: 'test' });
  assert.equal(r.action, 'new');
  assert.equal(r.unsubmitted, undefined);
});

test('start never reports the live comments file or other working files as archives', async () => {
  const doc = makeDoc();
  // A draft comments file left behind without a review file (a crash mid-ending).
  leafComments(doc, 'gone-id', 1, { comments: [comment('c1', 1, 'draft')] });
  const p = paths(doc);
  writeJSONAtomic(p.replies('gone-id', 1), { reviewId: 'gone-id', round: 1, replies: [] });
  fs.writeFileSync(p.staged('gone-id', 1), 'x');
  const r = await start(doc, undefined, { owner: 'test' });
  assert.equal(r.action, 'new');
  assert.equal(r.unsubmitted, undefined);
  // And restore refuses to treat it as an archive, so it is never deleted.
  const rr = await restore(doc, r.reviewId, p.comments);
  assert.equal(rr.result, 'refused');
  assert.ok(fs.existsSync(p.comments));
});

test('restore appends the archived comments with fresh ids and removes the archive', async () => {
  const doc = makeDoc();
  const file = archiveOf(doc, ARCHIVE_ID, { comments: [comment('c1', 1, 'one'), comment('c2', 1, 'two')] });
  const id = await started(doc);
  leafComments(doc, id, 1, { comments: [comment('c1', 1, 'retyped')] });
  const p = paths(doc);
  const r = await restore(doc, id, file);
  assert.deepEqual(r, { result: 'restored', reviewId: id, round: 1, count: 2, ids: ['c2', 'c3'] });
  const c = readJSON(p.comments);
  assert.deepEqual(c.comments.map(x => [x.id, x.round, x.text]), [['c1', 1, 'retyped'], ['c2', 1, 'one'], ['c3', 1, 'two']]);
  assert.equal(c.lastCommentNumber, 3);
  assert.equal(c.status, 'draft');
  assert.ok(!fs.existsSync(file), 'archive removed');
  assert.deepEqual(readJSON(p.review).reviewId, id);
});

test('restore before Leaf wrote a comments file creates one for the round', async () => {
  const doc = makeDoc();
  const file = archiveOf(doc, ARCHIVE_ID, { comments: [comment('c1', 1, 'one')] });
  const id = await started(doc);
  const r = await restore(doc, id, file);
  assert.equal(r.count, 1);
  const c = readJSON(paths(doc).comments);
  assert.equal(c.reviewId, id);
  assert.equal(c.round, 1);
  assert.deepEqual(c.enteredRounds, []);
  assert.deepEqual(c.comments.map(x => x.id), ['c1']);
});

test('restore before Leaf enters the published round moves the file to that round as a draft', async () => {
  const doc = makeDoc();
  const file = archiveOf(doc, ARCHIVE_ID, { comments: [comment('c1', 1, 'one')] });
  const id = await submittedRound1(doc);
  stageAndReply(doc, id, 1, '# Doc\n\nRevised.\n');
  assert.equal((await publish(doc, id, 1)).result, 'published');
  const r = await restore(doc, id, file);
  assert.deepEqual(r, { result: 'restored', reviewId: id, round: 2, count: 1, ids: ['c2'] });
  const c = readJSON(paths(doc).comments);
  assert.equal(c.round, 2);
  assert.equal(c.status, 'draft');
  assert.equal(c.submittedTextHash, null);
  assert.deepEqual(c.enteredRounds, [1], 'round 2 is not claimed as entered');
  assert.deepEqual(c.comments.map(x => [x.id, x.round]), [['c1', 1], ['c2', 2]], 'round 1 history kept');
});

test('restore is refused while a publish is interrupted, and recovery still works after', async () => {
  const doc = makeDoc();
  const file = archiveOf(doc, ARCHIVE_ID, { comments: [comment('c1', 1, 'one')] });
  const id = await submittedRound1(doc);
  stageAndReply(doc, id, 1, '# Doc\n\nRevised.\n');
  // Interrupted right after the round 2 review file is written: the staged file remains.
  const r = await publish(doc, id, 1, { abortAfter: 1 });
  assert.notEqual(r.result, 'published');
  assert.ok(fs.existsSync(paths(doc).staged(id, 1)));
  const rr = await restore(doc, id, file);
  assert.equal(rr.result, 'refused');
  assert.match(rr.message, /interrupted/);
  assert.ok(fs.existsSync(file), 'archive kept');
  assert.equal(readJSON(paths(doc).comments).round, 1, 'comments untouched');
  // The owner's start finishes the publish; restore then lands on round 2.
  const s = await start(doc, id, { owner: 'test' });
  assert.equal(s.action, 'resume');
  assert.equal(readJSON(paths(doc).review).round, 2);
  assert.equal((await restore(doc, id, file)).result, 'restored');
});

test('restore is refused on a submitted round, a wrong id, or a missing archive', async () => {
  const doc = makeDoc();
  const file = archiveOf(doc, ARCHIVE_ID, { comments: [comment('c1', 1)] });
  const id = await submittedRound1(doc);
  assert.equal((await restore(doc, id, file)).result, 'refused');
  assert.equal((await restore(doc, 'other', file)).result, 'refused');
  assert.equal((await restore(doc, id, file + '.missing')).result, 'refused');
  assert.ok(fs.existsSync(file));
});
