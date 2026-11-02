---
name: review
description: "Start or continue a Leaf review of a markdown file: the user comments in Leaf, Submit returns the comments here, Claude revises a staged copy and publishes the next round. Use when the user types /leaf:review <path> or /leaf:review done <path>."
---

# Leaf review

The user reviews a markdown file in Leaf and their comments come back to this session
as files in `.leaf/` beside the document. You revise a staged copy, write one reply per
comment, and publish; Leaf shows the revision with the changes highlighted. The loop
runs until they approve (submit with no comments), click End review in Leaf, or run
`/leaf:review done <path>`.

Script: `${CLAUDE_PLUGIN_ROOT}/skills/review/leaf-review.mjs` (Node, no dependencies). Every
subcommand prints one JSON line on stdout. Run it with `node`.

Rules that never bend:

- The user starts a review; you never run `start` on your own initiative.
- Pass the review id to every call once you know it (from `start`'s output in this
  conversation). A `start` without the id on an active review is refused.
- Never edit the document during a review. Edit the staged copy
  `.leaf/<name>.<id>.r<N>.revision.md`; `publish` moves it into place.
- Never end a review except through zero-comment approval (`start` or `wait` tells
  you) or when the user asks for `done`.
- One reply per comment id, one line each, including comments you did not act on and
  why. A missing reply makes `publish` refuse.

## `/leaf:review <path>`

1. Check Leaf is installed: `[ -d /Applications/Leaf.app ] || mdfind "kMDItemCFBundleIdentifier == 'com.slavhurmanau.leaf'" | grep -q .`.
   If neither, say Leaf is not installed, give https://github.com/lucky72o/leaf, and stop.
   Then resolve the path. Refuse anything that is not an existing `.md` or `.markdown` file.
2. Run `node ${CLAUDE_PLUGIN_ROOT}/skills/review/leaf-review.mjs start <path> [id] --owner "<short label for this session>"`
   and branch on `action`:
   - `refused` (exit 4): show the message with the id, round and owner, and stop.
   - `changed` (exit 8): a publish was interrupted and the file changed since. Handle it
     exactly like `changed` from `publish` in step 6 (the staged copy is still there).
   - `approved`: say "no remarks, approved" and stop.
   - `needs-replies`: go to step 5 with the printed `markdown`, `round` and `submittedTextHash`.
   - `new` or `resume`: continue.
3. Open the file in Leaf in the foreground: `open -a Leaf <path>`. The user asked for
   the review and expects the window.
4. Run the wait as a background command so the session stays usable:
   `node ${CLAUDE_PLUGIN_ROOT}/skills/review/leaf-review.mjs wait <path> <id> <round>`.
   Tell the user in one line that the review is open in Leaf, round N.
   If `start` printed `unsubmitted` (comments from an earlier review of this file that
   were ended without Submit), list them one line each right after that line and ask
   whether to restore them. On yes run
   `node ${CLAUDE_PLUGIN_ROOT}/skills/review/leaf-review.mjs restore <path> <id> <archive>`
   with the `archive` path from the entry; the comments appear in Leaf as drafts of the
   current round with new ids. On no, leave the archive alone and say nothing more.
   - Exit 0 with `count` 0: say "no remarks, approved", run `done <path> <id>`, stop.
   - Exit 0 with comments: go to step 5.
   - Exit 2: say the wait timed out (4 hours) and that `/leaf:review <path>` resumes it. Stop.
   - Exit 3: say the review was ended in Leaf. Stop.
5. Say the comments back in one line each (the `markdown` has them with ids, heading,
   source line and quote). Copy the document to the staged copy:
   `cp <path> <dir>/.leaf/<name>.<id>.r<N>.revision.md`. Edit the staged copy. Write
   the replies file `<dir>/.leaf/<name>.<id>.r<N>.replies.json`:
   `{"reviewId": "<id>", "round": N, "replies": [{"commentId": "c1", "text": "one line"}, ...]}`.
6. Run `node ${CLAUDE_PLUGIN_ROOT}/skills/review/leaf-review.mjs publish <path> <id> <N>` and branch on `result`:
   - `published`: start `wait <path> <id> <N+1>` in the background, tell the user in one
     line that the revision is in Leaf (round N+1), then handle the wait as in step 4.
   - `changed` (exit 8): the file changed after they submitted. Tell them so and ask
     whether to redo the revision on the current text. On yes: copy the current document to the
     staged copy again, redo the edits, and publish with `--expect <actual hash from the output>`.
     Otherwise stop; they can end the review.
   - `incomplete` (exit 7): fix the replies file (the output lists `missing` ids) and publish again.
   - `cancelled` (3) or `stale` (6) or `no-revision` (5): say so and stop.

## `restore`

`restore <path> <id> <archive-file>` copies the comments of an unsubmitted archive into
the active review's current round as drafts (fresh ids) and deletes the archive. It is
refused when the round is already submitted, the id is wrong or the archive is missing.
Only run it after the user said yes.

## `/leaf:review done <path>`

Run `node ${CLAUDE_PLUGIN_ROOT}/skills/review/leaf-review.mjs done <path>`. It archives the
comments as `.leaf/<name>.comments.<id>.json`, removes the review's working files and
is harmless when nothing is active.

## Reporting style

One line per event: review open, comments received (then one line per comment),
revision published, approved. No summaries of the protocol.
