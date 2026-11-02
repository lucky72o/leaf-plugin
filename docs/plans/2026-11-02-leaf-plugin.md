# Leaf Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public Claude Code plugin `leaf` (repo `lucky72o/leaf-plugin`) with `/leaf:read` and `/leaf:review`, and a Leaf repo that no longer carries the skill.

**Architecture:** Two repos change. The plugin repo gets manifests, the review skill moved from Leaf with its protocol tests, and a new read skill whose resolver is a dependency-free Node script with its own tests. The Leaf repo keeps the two tests that exercise its page script, drops `skill/`, and its scripts point at the plugin checkout. Tasks 1 to 3 are in the plugin repo, Task 4 in the Leaf repo, Task 5 publishes and installs.

**Tech Stack:** Node 20+ (`node:test`, no dependencies), bash, Claude Code plugin manifests, `gh`, `claude plugin` CLI.

**Spec:** `docs/specs/2026-11-02-leaf-plugin-design.md` in this repo.

## Global Constraints

- No em dashes in anything written for either repo.
- Nothing in the plugin's runtime files (`skills/`, `scripts/`, `README.md`) refers to the author's machine, folders or name: `scripts/test.sh` checks that `grep -rniE 'slav' skills README.md | grep -v 'com.slavhurmanau.leaf'` and `grep -rn '/Users/' skills README.md` are both empty, and separately that `grep -rn '/Users/' scripts --exclude=test.sh` is empty, so the checker never matches its own source. The bundle id `com.slavhurmanau.leaf` is Leaf's identifier and stays. Manifests, LICENSE and `docs/` carry attribution and history and are not checked.
- Node requirement is 20+: test commands use shell-expanded globs, never a quoted glob.
- Both scripts are plain Node, no dependencies, no `package.json` dependencies.
- Leaf-side smoke scripts launch with `open -n -g` and kill only PIDs they wrote; `scripts/smoke-review.sh` opens several Leaf windows behind the user's work, so Task 4's smoke run needs the user's go-ahead.
- Commits stage explicit files; `git diff --cached --stat` before each commit.
- The spec's resolver values are fixed: depth 6, 10 results, stop words `the a an from in of my project file md markdown`, substring match needs 3+ characters, scores +3 name, +1 path, +2 project.

## Review Focus

- Words that are an existing file name in `--cwd` with no slash (`README.md`): opened directly, not searched (Task 3 test `bare file name in cwd`).
- A sibling directory that is not a git repo (a plain folder of notes next to the project): still searched as a sibling; only the project itself needs to be a git top level for siblings to be considered (Task 3 test `sibling folder without git`).
- Case: a user types `Daily Plan` and the file is `daily-plan.md` (Task 3 test `case insensitive`).
- Unicode file names (`план.md`) with the letter/digit tokeniser: `\p{L}\p{N}` classes, not `\w` (Task 3 test `unicode tokens`).
- A `.leaf/` revision copy must never be a match, since it is a near-duplicate of the document (Task 3 test `skips .leaf`).

---

### Task 1: Plugin scaffold

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `LICENSE` (MIT, "Slav Gurmanov" is the licence holder, which is the one permitted appearance of the author's name), `README.md`, `scripts/test.sh`, `.gitattributes`, `.gitignore`

**Interfaces:**
- Produces: `scripts/test.sh`, exit 0 only when: both manifests parse as JSON; `plugin.json` has `name` `leaf`; every `skills/*/SKILL.md` has a frontmatter `name:` equal to its directory name; the two greps from Global Constraints are empty; `node --test skills/*/test/*.test.mjs` passes (skipped with a note while no test files exist, so Task 1 can pass).

- [ ] **Step 1: Write the manifests**

`plugin.json`: `{"name": "leaf", "description": "Read and review markdown in the Leaf Mac app from Claude Code: /leaf:read opens the file you describe, /leaf:review runs a comment-and-revise loop.", "version": "0.1.0", "author": {"name": "Slav Gurmanov"}, "license": "MIT", "homepage": "https://github.com/lucky72o/leaf-plugin"}`.
`marketplace.json`: `{"name": "leaf-plugin", "owner": {"name": "Slav Gurmanov"}, "plugins": [{"name": "leaf", "source": "./", "description": <same description>}]}`.
Ruling on the author's name: it appears in the manifests' `author`/`owner` fields and in LICENSE, which the spec's "nothing refers to the author" rule does not cover (attribution is not coupling); the greps cover only runtime files, see Global Constraints.

- [ ] **Step 2: Write `scripts/test.sh`** as specified in Interfaces; `.gitattributes` with `fixtures/hash/crlf.md -text`; `.gitignore` with `node_modules/` and `.DS_Store`.

- [ ] **Step 3: Run it**

Run: `scripts/test.sh`
Expected: manifest checks print `ok`, the node line prints `no tests yet`, exit 0. Then `claude plugin validate .` prints that the plugin manifest is valid.

- [ ] **Step 4: README**

Sections: what it is (two commands, one paragraph each), Requirements (Leaf 0.1.0+ in /Applications with its repo link, Claude Code, Node 20+), Install (the two `/plugin` lines), Working on it (`/plugin marketplace add ~/path/to/leaf-plugin`, `scripts/test.sh`), How the review loop works (one paragraph pointing at Leaf's README for the Leaf side). No em dashes.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin LICENSE README.md scripts/test.sh .gitattributes .gitignore
git diff --cached --stat
git commit -m "feat: plugin scaffold, manifests and test runner"
```

### Task 2: Move the review skill

**Files:**
- Create: `skills/review/SKILL.md`, `skills/review/leaf-review.mjs`, `skills/review/lib/{files,hash,lock,paths,render,state}.mjs`, `skills/review/test/{helpers,hash.test,render.test,state.test,lock.test,paths.test}.mjs`, `fixtures/hash/{bom.md,crlf.md,latin1.md,utf8.md,expected.json}`, `fixtures/review/comments-example.md`
- Source: `~/work/leaf/skill/leaf-review/` and `~/work/leaf/fixtures/` (copy with `cp`, byte-exact; `crlf.md` must keep CRLF, verify with `file`)

**Interfaces:**
- Produces: `skills/review/test/helpers.mjs` exporting only `repoRoot` = the plugin root, computed as today with `path.resolve(dirname, '../../..')` (test dir to review to skills to root: three levels). No `loadCore`, no `vm` import.
- Produces: `state.mjs` `changed` message text: `publish was interrupted and the document changed since. The staged revision is kept. Ask the user whether to redo it on the current text, then publish with --expect <hash>, or end the review.`

- [ ] **Step 1: Copy script, lib, the five protocol tests and fixtures** (not `review-core.test.mjs`, not `chunking.test.mjs`). Write the new `helpers.mjs`.

- [ ] **Step 2: Run the tests before any edit**

Run: `node --test skills/review/test/*.test.mjs`
Expected: all pass (hash fixtures resolve through the new `repoRoot`). If `hash.test` fails on `crlf.md`, the copy lost CRLF: recopy with `cp` and check `.gitattributes`.

- [ ] **Step 3: Failing test for the reworded message**

In `state.test.mjs`, the test `interrupted publish is refused when the document changed in between` (line 345 in the original) gets one assertion: `assert.match(r.message, /Ask the user whether to redo/)`. Run; expected FAIL (message still says "Ask Slav").

- [ ] **Step 4: Reword** the message in `lib/state.mjs` and the comment above the unsubmitted-archive code ("comments Slav wrote" becomes "comments the user wrote"). Run; expected PASS.

- [ ] **Step 5: Write `skills/review/SKILL.md`**

Start from the original. Frontmatter `name: review`; description: "Start or continue a Leaf review of a markdown file: the user comments in Leaf, Submit returns the comments here, Claude revises a staged copy and publishes the next round. Use when the user types /leaf:review <path> or /leaf:review done <path>." Body: every `~/.claude/skills/leaf-review/leaf-review.mjs` becomes `${CLAUDE_PLUGIN_ROOT}/skills/review/leaf-review.mjs`; the slash command `/leaf-review` (the headings `## /leaf-review <path>` and `## /leaf-review done <path>` and the sentences that mention typing it) becomes `/leaf:review`, while the script file name `leaf-review.mjs` is never touched (check: `grep -n '/leaf-review' SKILL.md | grep -v 'leaf-review.mjs'` prints nothing, and `grep -c 'skills/review/leaf-review.mjs' SKILL.md` is at least 5); "Slav" becomes "the user", "he/his/him" becomes "they/their/them"; a new first step under the command heading: "Check Leaf is installed: `[ -d /Applications/Leaf.app ] || mdfind "kMDItemCFBundleIdentifier == 'com.slavhurmanau.leaf'" | grep -q .`; if neither, say Leaf is not installed, give https://github.com/lucky72o/leaf, and stop." Nothing else changes.

- [ ] **Step 6: Run the whole plugin suite, here and standalone**

Run: `scripts/test.sh`
Expected: exit 0.
The standalone run happens after Task 3's commit (see Task 3 Step 6), so that the committed revision holds both skills.

- [ ] **Step 7: Commit**

```bash
git add skills/review fixtures
git diff --cached --stat
git commit -m "feat(review): the review skill, moved from the Leaf repo"
```

### Task 3: `/leaf:read` and `find-md.mjs`

**Files:**
- Create: `skills/read/find-md.mjs`, `skills/read/test/find-md.test.mjs`, `skills/read/SKILL.md`

**Interfaces:**
- Produces: `node skills/read/find-md.mjs --cwd <dir> <words...>` printing one JSON line as the spec's `/leaf:read` section defines (`{"matches": [...]}` exit 0, `{"error": "..."}` exit 64).
- Produces, exported from `find-md.mjs` for the tests: `cleanWords(words: string[]): string`, `explicitPath(cleaned: string, cwd: string): {path?: string, error?: string} | null` (null when not explicit), `terms(words: string[]): string[]`, `tokens(text: string): string[]`, `roots(cwd: string, {home: string, fsRoot: string}): {project: string, siblings: string[], error?: string}` (the project is `git -C <cwd> rev-parse --show-toplevel` through `execFileSync`; any failure means non-repository mode with `project = cwd`; `fsRoot` defaults to `/` and is injected by tests so a temp directory can play the filesystem root), `search(rootsResult, terms): Match[]`, `main(argv): {out: object, code: number}`.

- [ ] **Step 1: Write the failing tests** in `find-md.test.mjs`, each building its tree in a fresh `fs.mkdtempSync` dir. Repositories are real: `execFileSync('git', ['init', '-q'], {cwd})`. `home` and `fsRoot` are passed explicitly, never taken from the environment:

```js
test('literal path: quotes, file URL with encoded space, :line:col', ...)   // file:///<tmp>/release%20plan.md:12:3 → that file, score 100
test('explicit missing path never searches', ...)                            // docs/release-plan.md absent, docs/release-plan-draft.md present → error "no such file: <abs>"
test('explicit non-markdown file', ...)                                      // notes.txt → error "not a markdown file"
test('bare file name in cwd', ...)                                           // README.md exists in cwd → only match
test('no search terms', ...)                                                 // words "the file" → error "no search terms"
test('too broad', ...)                                                       // cwd = home, = fsRoot, or a child of fsRoot → error "working directory too broad for a search; give a path"; also through a symlink alias of home (realpath)
test('git top level, not a .git marker', ...)                                // a real repo in a subdir → project is the repo root; an empty .git directory → non-repo, project = cwd; a worktree (.git file from `git worktree add`) → its own top level
test('no siblings when the project parent is home, fsRoot or a child of fsRoot', ...)  // real repo directly under each → siblings []
test('terms match project name of a sibling', ...)                           // "daily plan from the sleepeasy project" → <parent>/sleepeasy/docs/daily-plan.md
test('.markdown files', ...)                                                 // literal notes.markdown opens; search finds plan.markdown
test('all terms required, no partial', ...)                                  // "daily plan budget" with daily-plan.md → []
test('exact scores', ...)                                                    // "daily plan" on project docs/daily-plan.md = 3+3+2 = 8; sibling x/daily/plan.md = 1+3 = 4; mtime breaks an exact tie
test('case insensitive', ...)                                                // "Daily Plan" → daily-plan.md
test('unicode tokens', ...)                                                  // "план" → план.md
test('substring needs 3 chars', ...)                                         // "pl" does not match planning.md; "plan" does
test('depth 6 included, depth 7 excluded', ...)                              // a/b/c/d/e/f/plan.md found, a/b/c/d/e/f/g/plan.md not
test('skips .leaf, node_modules, dot dirs except .claude, symlinks', ...)
test('sibling folder without git', ...)                                      // sibling plain folder is searched when project has .git
test('no siblings for a non-repo cwd', ...)
test('at most 10 matches', ...)
test('main prints one JSON line and exit code', ...)
```

Run: `node --test skills/read/test/*.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 2: Implement `find-md.mjs`** per the spec sections Step 1 to Step 4 and the Interfaces signatures. Tokeniser: `text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)`. Walk with `fs.readdirSync(dir, {withFileTypes: true})`, `lstat` semantics (Dirent `isSymbolicLink()` skipped). `realpath` on cwd, home, project and parent before the broad check. In `main`, home is `os.homedir()` and `fsRoot` is `/`; both injected in `roots` for tests.

- [ ] **Step 3: Run; expected all PASS.** Then `scripts/test.sh`; expected exit 0.

- [ ] **Step 4: Write `skills/read/SKILL.md`**

Frontmatter `name: read`, description: "Open the markdown file the user describes in the Leaf Mac app: a path, a file name, or plain words like 'daily plan from the sleepeasy project'. Use when the user types /leaf:read <words>." Body, in this order: the Leaf-installed check (same line as the review skill); run `node ${CLAUDE_PLUGIN_ROOT}/skills/read/find-md.mjs --cwd "<session working directory>" <the user's words, each as its own argument>`; the three outcomes from the spec's Step 5 with exact behaviour (one match: `open -a Leaf <path>`, say the path; several: numbered list of up to 5 paths relative to the project's parent, ask, a number opens that one, more words rerun with words appended; none: one line, plus the "no such file under the project or its siblings" sentence when the words contained `/` or ended in `.md`; error JSON: say the message); the rules: never open before an answer when there was a choice, never create a file, never start a review, never widen the search. Reporting style: one line.

- [ ] **Step 5: Commit**

```bash
git add skills/read
git diff --cached --stat
git commit -m "feat(read): /leaf:read resolves a description to one markdown file and opens it in Leaf"
```

- [ ] **Step 6: Standalone run of the committed revision, away from any Leaf checkout**

```bash
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git clone -q "$PWD" "$T/leaf-plugin" && (cd "$T/leaf-plugin" && scripts/test.sh)
```
Expected: `scripts/test.sh` exits 0 and its node line reports tests from both `skills/read/test` and `skills/review/test` (the "no tests yet" branch must not print). `/tmp` has no Leaf checkout beside it, so a reference back into `../leaf` fails here. Task 4 deletes the original skill only after this passed.

### Task 4: Leaf repo

**Files (in `~/work/leaf`, on a branch `plugin-move` off `main`):**
- Delete: `skill/` (whole directory)
- Create: `Tests/review-core/helpers.mjs` (only `repoRoot` two levels up and `loadCore`), `Tests/review-core/review-core.test.mjs`, `Tests/review-core/chunking.test.mjs` (moved from `skill/leaf-review/test/`, imports unchanged since `helpers.mjs` sits beside them; `chunking.test.mjs` also imports `repoRoot`)
- Modify: `scripts/test-all.sh:6`, `scripts/smoke-review.sh:8-10` and every `$CLI` call, `scripts/install.sh:32-41`, `README.md:49-72` and `:86-110`, `docs/superpowers/specs/2026-10-25-review-mode-design.md:439-442`

**Interfaces:**
- Consumes: the plugin checkout at `${LEAF_PLUGIN_DIR:-$PWD/../leaf-plugin}` for `scripts/smoke-review.sh`.

- [ ] **Step 1: Move the two app tests and write the helper.** Run `node --test Tests/review-core/*.test.mjs`; expected PASS (the `repoRoot` fix is what makes `Sources/Leaf/Resources/review-core.js` resolve).

- [ ] **Step 2: `git rm -r skill`.** Run `scripts/test-all.sh` after changing its node line to `node --test Tests/review-core/*.test.mjs 2>&1 | grep -E "^# (pass|fail)" | tee /dev/stderr | grep -q "^# fail 0"`; expected both lines pass.

- [ ] **Step 3: `scripts/smoke-review.sh`**: replace the `CLI=` line with
```bash
SCRIPT="${LEAF_PLUGIN_DIR:-$PWD/../leaf-plugin}/skills/review/leaf-review.mjs"
[ -f "$SCRIPT" ] || { echo "leaf-plugin not found at $SCRIPT; clone https://github.com/lucky72o/leaf-plugin beside this repo or set LEAF_PLUGIN_DIR"; exit 2; }
```
placed before `scripts/build.sh`, and change every `$CLI` to `node "$SCRIPT"`. Check with `grep -n '\$CLI' scripts/smoke-review.sh`; expected no output. Negative check: `LEAF_PLUGIN_DIR=/nonexistent scripts/smoke-review.sh`; expected the message and exit 2 with no build and no window. Positive run, with the user's go-ahead (opens windows): `scripts/smoke-review.sh`; expected its final pass line.

- [ ] **Step 4: `scripts/install.sh`**: replace the symlink block with: if `~/.claude/skills/leaf-review` is a symlink whose target starts with `$PWD/skill`, remove it and print "removed the old leaf-review skill link"; then print the two `/plugin` install lines. Run `bash -n scripts/install.sh`; expected no output.

- [ ] **Step 5: Docs.** README "Reviewing with Claude Code": first sentence becomes the install pointer ("Install the leaf plugin for Claude Code: `/plugin marketplace add lucky72o/leaf-plugin`, then `/plugin install leaf@leaf-plugin`"), `/leaf-review` becomes `/leaf:review` throughout, the "The skill lives in..." sentences become "The skill lives in the leaf-plugin repo; `scripts/smoke-review.sh` drives it against the built app from a checkout beside this one or `LEAF_PLUGIN_DIR`." Add one sentence before that section's last paragraph: "`/leaf:read <words>` opens the file you describe in Leaf, no review." Development block: the `test-all.sh` comment becomes "swift test plus the page script's node tests", the `node --test "skill/..."` line becomes `node --test Tests/review-core/*.test.mjs   # the page script alone`. Layout: `skill/leaf-review ...` becomes `Tests/review-core (node tests of the page script)`. Design doc "The skill" section: first line "Moved to https://github.com/lucky72o/leaf-plugin on 2026-11-02; the description below is as built here." Check: `grep -rn "leaf-review\|skill/" README.md scripts/*.sh` returns only the install.sh removal line and the smoke script's variable; `grep -rn "—" README.md` nothing new.

- [ ] **Step 6: Commit**

```bash
git add -A Tests/review-core scripts/test-all.sh scripts/smoke-review.sh scripts/install.sh README.md docs/superpowers/specs/2026-10-25-review-mode-design.md
git diff --cached --stat     # the skill/ deletion is already staged by Step 2's git rm
git commit -m "refactor: the Claude Code skill moves to the leaf-plugin repo"
```

### Task 5: Publish and install

- [ ] **Step 1: Create the public repo and push** (plugin repo, branch `main`):
```bash
gh repo create lucky72o/leaf-plugin --public --source . --description "Claude Code plugin for the Leaf markdown reader: /leaf:read and /leaf:review" --push
```
Expected: the repo URL printed, `git remote -v` shows origin.

- [ ] **Step 2: Install from GitHub on this machine**
```bash
claude plugin marketplace add lucky72o/leaf-plugin
claude plugin install leaf@leaf-plugin
claude plugin details leaf@leaf-plugin
```
Expected: details lists skills `read` and `review`. Then in a new Claude Code session type `/leaf:read README.md` with `~/work/leaf` as cwd; expected Leaf opens it. Ask the user to run `/leaf:review` on any file once as the acceptance for the moved skill.

- [ ] **Step 3: Leaf side.** Push `plugin-move` and open a PR against `main` in `lucky72o/leaf`, titled "The Claude Code skill moves to leaf-plugin". `scripts/install.sh` run by the user on merge removes the old symlink.
