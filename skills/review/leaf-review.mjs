#!/usr/bin/env node
// The leaf-review skill's script: hash, start, wait, publish, done, restore.
// Each subcommand prints one JSON line on stdout; human lines go to stderr.
import { hashFile } from './lib/hash.mjs';

const [cmd, ...rest] = process.argv.slice(2);

function usage() {
  process.stderr.write('usage: leaf-review.mjs hash <path> | start <path> [id] [--owner <label>] | wait <path> <id> <round> | publish <path> <id> <round> [--expect <hash>] | done <path> [id] | restore <path> <id> <archive-file>\n');
  process.exit(64);
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1]; i++; }
    else positional.push(args[i]);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case 'hash': {
      if (!positional[0]) usage();
      console.log(JSON.stringify({ textHash: hashFile(positional[0]) }));
      return 0;
    }
    case 'start': case 'wait': case 'publish': case 'done': case 'restore': {
      const state = await import('./lib/state.mjs');
      return state.run(cmd, positional, flags);
    }
    default: usage();
  }
}

main().then(code => process.exit(code || 0), err => { process.stderr.write(String(err.stack || err) + '\n'); process.exit(1); });
