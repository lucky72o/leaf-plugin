# Leaf plugin design

## Intent

Leaf's Claude Code integration moves out of the Leaf repo into its own public repo,
`lucky72o/leaf-plugin`, as a Claude Code plugin named `leaf`. Anyone with Leaf installed
adds the plugin and gets two commands in every Claude Code session:

- `/leaf:read <words>`: open the markdown file you mean in Leaf, described in plain words.
- `/leaf:review <path>` and `/leaf:review done <path>`: the existing review loop, unchanged.

Today the review skill is installed by a symlink from `~/.claude/skills/leaf-review` into
the Leaf checkout, its instructions name the owner ("Slav"), and nothing exists for simply
opening a file. The plugin fixes all three and is the thing other people install.

## Goals

- One plugin, two skills, namespaced as `/leaf:read` and `/leaf:review`.
- Installable by anyone from GitHub through Claude Code's plugin marketplace. Requirements
  beyond Claude Code: the Leaf app, and Node 20 or later on the PATH (both skills run a
  Node script).
- Nothing in the plugin refers to the author's machine, folders, or name.
- The review loop behaves exactly as it does now; its script and tests move with it.
- The Leaf repo keeps building, installing and smoke-testing on its own, and its
  `scripts/smoke-review.sh` (which drives the whole review loop through the script) keeps
  working when the plugin checkout is beside it.

## Non-goals

- No change to the review protocol, the `.leaf/` files, or Leaf's Swift code.
- No `/leaf:read` features beyond resolving a description to one file and opening it: no
  review, no editing, no opening several files, no remembering what was opened.
- No automatic publishing of Leaf itself; the Leaf repo stays where it is (currently
  private; making it public is a separate decision the plugin README should not depend on).
- No backward-compatibility shim for `/leaf-review`. The author is the only user of it.

## Anti-goals

- A `/leaf:read` that guesses wrong silently. When several files could be meant it asks;
  when none, it says so. It never opens the closest match "just in case".
- A plugin that only works when the Leaf repo is checked out at a particular path.
- Instructions that make Claude start or end a review on its own.

## The plugin repo

`lucky72o/leaf-plugin`, public, MIT licence (same as the author intends for Leaf).

```
.claude-plugin/plugin.json        name "leaf", description, version "0.1.0", author
.claude-plugin/marketplace.json   name "leaf-plugin", one plugin "leaf" with source "./"
skills/read/SKILL.md              /leaf:read (frontmatter name: read)
skills/read/find-md.mjs           resolves words to candidate files, prints JSON
skills/read/test/*.test.mjs       node --test, with fixtures made in a temp dir
skills/review/SKILL.md            /leaf:review (frontmatter name: review; moved and reworded)
skills/review/leaf-review.mjs     moved unchanged
skills/review/lib/*.mjs           moved; one message reworded (see below)
skills/review/test/*.test.mjs     the protocol tests, moved (see "Tests" below)
fixtures/hash/*, fixtures/review/comments-example.md   copied from Leaf for those tests
.gitattributes                    keeps fixtures/hash/crlf.md with its CRLF bytes, as in Leaf
scripts/test.sh                   node --test over both skills' tests, plus manifest checks
docs/specs, docs/plans            this document and its plan
README.md, LICENSE
```

Install, as the README states it:

```
/plugin marketplace add lucky72o/leaf-plugin
/plugin install leaf@leaf-plugin
```

For working on the plugin itself, the marketplace can be added from a local checkout
(`/plugin marketplace add ~/work/leaf-plugin`) so edits are live after a reinstall.

Skills reference their scripts as `${CLAUDE_PLUGIN_ROOT}/skills/<name>/<script>`; this is
the only way a plugin skill can name its own files, since the install location is Claude
Code's. The command's last segment comes from the SKILL.md frontmatter `name`, not the
directory, so the two files carry `name: read` and `name: review`; the install is verified
by running `/leaf:read` and `/leaf:review` in a session.

Requirement line in the README: "Leaf 0.1.0 or later, installed in /Applications" (Leaf's
`CFBundleShortVersionString`; bump both together when the review protocol changes). Both
skills check that Leaf is installed before doing anything: `mdfind
"kMDItemCFBundleIdentifier == com.slavhurmanau.leaf"` or the existence of
`/Applications/Leaf.app`; if neither, say so with the Leaf repo link and stop.

## `/leaf:read <words>`

The user describes a file: a path, a file name, or words like "daily plan from the
sleepeasy project". Claude resolves it to exactly one existing `.md` or `.markdown` file
and opens it in Leaf with `open -a Leaf <path>`. Leaf itself puts it in a tab of the
existing window (app behaviour, already shipped).

Resolution is done by `find-md.mjs` so it is deterministic and tested:

```
node ${CLAUDE_PLUGIN_ROOT}/skills/read/find-md.mjs --cwd <dir> <words...>
```

Output is one JSON line. Success: `{"matches": [{"path": "<absolute>", "score": n,
"mtime": "<ISO>"}]}`, best first, at most 10 entries, possibly empty. Error:
`{"error": "<message>"}` with exit 64 (no usable search terms, `--cwd` missing or not a
directory). `--cwd` is the session's working directory, which Claude knows.

### Step 1: a literal path

The words joined by single spaces are first cleaned: surrounding quotes and backticks
removed, then a trailing `:line` or `:line:col` removed. The result is an explicit path
when it starts with `/`, `~/` or `file:`, or contains a `/`. An explicit path is resolved
and nothing else runs:

- `file:` URLs go through Node's `fileURLToPath`, which decodes percent escapes and
  accepts `file://localhost/...`; a URL it rejects is the error "not a file URL".
- `~/` is expanded to the home directory; a path without a leading `/` is resolved
  against `--cwd`.
- An existing regular file ending in `.md` or `.markdown` is the only match (score 100).
- An existing file with another extension is the error "not a markdown file".
- Anything else is the error "no such file: <resolved path>". A missing explicit path
  never falls through to the word search, so `docs/release-plan.md` cannot open
  `docs/release-plan-draft.md`.

Words with no `/` that happen to name a file in `--cwd` (`README.md`) are also tried as
that file first; if it exists it is the only match, otherwise they continue as terms.

### Step 2: terms

Otherwise the words become terms. Every word is lower-cased and split on anything that is
not a letter or digit (so `daily-plan.md` gives `daily`, `plan`, `md`). Pieces that are
stop words are dropped: `the a an from in of my project file md markdown`. If no terms
remain, the error is "no search terms".

### Step 3: roots

The project is the git top level containing `--cwd` (`git rev-parse --show-toplevel`),
or `--cwd` itself when not in a repository. Paths are made canonical (`realpath`) before
any of the checks below. A project that is the filesystem root, the home directory, or a
direct child of the filesystem root is "too broad": the word search is refused with the
error "working directory too broad for a search; give a path", before anything is
walked. Roots, in order:

1. The project.
2. Sibling projects: every directory in the project's parent other than the project.
   Searched only when the project is a git top level and its parent is neither the
   filesystem root nor the home directory nor a direct child of the filesystem root
   (`/tmp`, `/Users`, `/Volumes`, `/private` and the like). A non-repository `--cwd`
   gets no siblings.

Each root is walked to a depth of 6 below it. Skipped: directory names `node_modules`,
`.git`, `.build`, `build`, `dist`, `vendor`, `.leaf`, and any other name starting with
`.` except `.claude`. Symlinks are not followed (neither directories nor files).
Unreadable entries are skipped silently. Only regular files ending in `.md` or
`.markdown` are candidates.

### Step 4: matching

A candidate's searchable text is its path relative to the root's parent, so the project
or sibling name is part of it: `sleepeasy/docs/daily-plan.md`. That text is lower-cased
and split into tokens the same way as the words (`sleepeasy`, `docs`, `daily`, `plan`,
`md`). A term matches a token when it equals it, or when the term has at least 3
characters and is a substring of the token (`plan` matches `planning`). A candidate
matches when every term matches at least one token. There is no partial matching and no
retry: the terms are the user's words, and a file that misses one of them is not what
they asked for.

Score, for ordering only: +3 per term that matches a token of the file name (the last
path segment), +1 per term that matches only elsewhere in the path, +2 when the file is
in the project rather than a sibling. Ties broken by most recent modification time, then
by path.

### Step 5: what the skill does with the result

- Exactly one match: open it with `open -a Leaf <path>` and say the path in one line.
- Two or more matches: show up to 5 as a numbered list (path relative to the project's
  parent, so the project name shows) and ask which. A number opens that one; more words
  rerun the search with the words appended to the original ones. Nothing is opened
  before the answer, however far ahead the first match is.
- No match: say so in one line. If the words looked like a path (contained `/` or ended
  in `.md`), add that no such file exists under the project or its siblings. Nothing is
  opened; nothing is created.

The skill never searches the home directory or the whole disk, never opens a file the
user did not name or pick, and never starts a review.

## `/leaf:review <path>` and `/leaf:review done <path>`

The current `skill/leaf-review` moved to `skills/review`, with these edits to `SKILL.md`
only:

- Frontmatter `name: review`; description and trigger text name `/leaf:review` and
  `/leaf:review done`.
- Name "Slav" replaced by "the user" and pronouns made neutral.
- Script path `~/.claude/skills/leaf-review/leaf-review.mjs` replaced by
  `${CLAUDE_PLUGIN_ROOT}/skills/review/leaf-review.mjs` everywhere.
- The Leaf-installed check from above, before `start`.

The script moves without change. In the library, the one user-facing message that names
the author (`state.mjs`, the `changed` result of an interrupted publish: "Ask Slav
whether to redo it") says "Ask the user" instead, and the comment above the unsubmitted
archive code is reworded; the protocol and every other string stay as they are.

### Tests

The current `test/` directory mixes two things:

- Protocol tests of the script's own library: `hash`, `render`, `state`, `lock`,
  `paths`. These move to the plugin. They need `fixtures/hash/*` (with the CRLF file
  stored byte-exact, hence the `.gitattributes` line) and
  `fixtures/review/comments-example.md`, which are copied into the plugin, and a
  `helpers.mjs` whose `repoRoot` is the plugin root.
- Tests of the app's own page script `Sources/Leaf/Resources/review-core.js`:
  `review-core.test.mjs` and `chunking.test.mjs`, which load that file and Leaf's
  vendored marked, fixtures and documents through `helpers.loadCore`. These stay in the
  Leaf repo, moved to `Tests/review-core/` with a `helpers.mjs` holding only `loadCore`
  and a `repoRoot` that resolves two levels up (the current one resolves three, which
  from the new place would leave the repo). The fixtures they read stay where they are
  under `fixtures/review/`, so the readers do not change. Leaf's `scripts/test-all.sh`
  runs them with `node --test Tests/review-core/*.test.mjs`, verified after `skill/` is
  removed.

The plugin's tests pass with no Leaf checkout anywhere. Leaf's tests pass after `skill/`
is removed. Both run with `node --test` and shell-expanded file lists (unquoted globs or
explicit paths), since Node's own glob expansion needs Node 21 and the requirement is 20.

## Changes in the Leaf repo

- `skill/` removed.
- `scripts/install.sh`: the symlink block goes. In its place, if
  `~/.claude/skills/leaf-review` is a symlink into this repo, remove it and say so; then
  print the two `/plugin` lines above as the way to get the commands.
- `scripts/test-all.sh`: the node line becomes `node --test Tests/review-core/*.test.mjs`.
- `scripts/smoke-review.sh`: the script path is
  `SCRIPT="${LEAF_PLUGIN_DIR:-$PWD/../leaf-plugin}/skills/review/leaf-review.mjs"`,
  checked before the build; when missing it prints how to get the plugin and exits 2
  (neither pass nor fail). Every call is `node "$SCRIPT" ...`, so a path with spaces
  works. README lists the variable.
- `README.md`: the "Reviewing with Claude Code" section says to install the plugin, uses
  the `/leaf:review` names, and the Development and Layout paragraphs drop the skill. A
  "Reading with Claude Code" sentence introduces `/leaf:read`.
- The 2026-10-25 review design document stays as history; one line at its "The skill"
  section notes the move.

## Decided for the builder

- Plugin name `leaf`, marketplace name `leaf-plugin`, repo `lucky72o/leaf-plugin`, version
  `0.1.0`, licence MIT, author "Slav Gurmanov".
- Both scripts are plain Node 20+, no dependencies.
- Scores and limits above are fixed values; the builder does not tune them.
- The plugin repo gets the same commit and review conventions as Leaf (Codex review
  rounds, no em dashes).

## Left to the builder

- The exact wording of `skills/read/SKILL.md`, within the behaviour above.
- How `find-md.mjs` walks directories (sync or async) and its test fixtures.
- `scripts/test.sh` at minimum checks that both manifests parse as JSON and that each
  SKILL.md frontmatter `name` matches its directory.

## Risks

- Claude Code's plugin manifest format changes: the README's install lines are the
  contract; the manifests follow the published schema at the time of writing.
- The review protocol drifts between the app and the plugin once they live apart. The
  version line in the README and the smoke test in the Leaf repo (which exercises the
  plugin's script against the built app) are the two guards.
