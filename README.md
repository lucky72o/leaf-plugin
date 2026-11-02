# leaf plugin for Claude Code

Two commands for working with markdown in [Leaf](https://github.com/lucky72o/leaf), the
small native Mac reader, from inside a Claude Code session.

**`/leaf:read <words>`** opens the file you describe in Leaf. Give it a path, a file name,
or plain words such as `daily plan from the sleepeasy project`. Claude resolves the words
to one existing `.md` or `.markdown` file in the current project or its sibling projects
and opens it; when several files fit it lists them and asks, and when none fit it says so.
It never opens a file you did not name or pick.

**`/leaf:review <path>`** starts a review loop for a markdown file: the file opens in Leaf
with a review bar, you comment on it there, Submit sends the comments back to the
session, Claude revises a staged copy and answers each comment, and the next round shows
up in the same Leaf tab with the changes highlighted. Approve (a Submit with no comments),
End review in Leaf, or `/leaf:review done <path>` ends it. Everything is files in a
`.leaf/` folder beside the document: no server, no network.

## Requirements

- [Leaf](https://github.com/lucky72o/leaf) 0.1.0 or later, installed in `/Applications`.
- Claude Code.
- Node 20 or later on the PATH (both commands run a small Node script).

## Install

In Claude Code:

```
/plugin marketplace add lucky72o/leaf-plugin
/plugin install leaf@leaf-plugin
```

## Working on it

Add the marketplace from your checkout instead, so edits are live after a reinstall:

```
/plugin marketplace add ~/path/to/leaf-plugin
/plugin install leaf@leaf-plugin
```

`scripts/test.sh` checks the manifests, the skill names, that nothing in the runtime files
refers to a particular machine, and runs the node tests of both skills.

## How the review loop works

The review skill's script (`skills/review/leaf-review.mjs`) and Leaf share a file
protocol under `.leaf/` next to the document: a review file the script writes, a comments
file Leaf writes, a replies file Claude writes, and a lock. The Leaf side, keys and all,
is described in Leaf's README; the protocol itself is in Leaf's
`docs/superpowers/specs/2026-10-25-review-mode-design.md`. The two halves are versioned
together: this plugin's version line in Requirements names the Leaf it needs.
