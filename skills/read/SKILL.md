---
name: read
description: "Open the markdown file the user describes in the Leaf Mac app: a path, a file name, or plain words like 'daily plan from the sleepeasy project'. Use when the user types /leaf:read <words>."
---

# Leaf read

The user describes a markdown file; you find exactly one existing `.md` or `.markdown`
file that matches and open it in Leaf. Nothing else: no review, no editing, no creating.

1. Check Leaf is installed: `[ -d /Applications/Leaf.app ] || mdfind "kMDItemCFBundleIdentifier == 'com.slavhurmanau.leaf'" | grep -q .`.
   If neither, say Leaf is not installed, give https://github.com/lucky72o/leaf, and stop.
2. Run the resolver with the session's working directory and the user's words, each word
   as its own argument:
   `node ${CLAUDE_PLUGIN_ROOT}/skills/read/find-md.mjs --cwd "<working directory>" <words...>`
   It prints one JSON line. It tries the words as a literal path first (absolute, `~/`,
   `file:` URL, or anything with a slash; a bare file name that exists in the working
   directory also counts), then searches the project (the git repository containing the
   working directory) and its sibling projects for files whose path contains every word.
3. Act on the output:
   - `{"matches": [one entry]}`: run `open -a Leaf <path>` and say the path in one line.
   - `{"matches": [two or more]}`: list up to 5 as a numbered list, each path shown
     relative to the project's parent so the project name is visible, and ask which.
     A number opens that entry with `open -a Leaf <path>`. More words rerun the resolver
     with the new words appended to the original ones. Open nothing before the answer,
     however far ahead the first entry is.
   - `{"matches": []}`: say in one line that nothing matched. If the words contained a
     `/` or ended in `.md`, add that no such file exists under the project or its
     siblings. Open nothing, create nothing.
   - `{"error": "..."}`: say the message in one line. "working directory too broad"
     means the session is running from the home directory or the filesystem root: ask
     for a path instead.

Rules that never bend: never open a file the user did not name or pick when there was a
choice; never create a file; never start a review; never widen the search beyond what
the resolver returns (no searching the home directory or the disk yourself).

Reporting style: one line per event.
