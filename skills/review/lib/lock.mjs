// The review lock: an exclusive flock(2) on the file <name>.lock, held by a helper
// process for as long as the caller needs it. The kernel releases it when the holder
// dies, so there is no owner file, no eviction and no stale-lock race. Leaf takes the
// same flock from Swift. Node has no flock of its own; /usr/bin/perl ships with macOS.
import { spawn } from 'node:child_process';

export const HOLDER_SCRIPT = `
use Fcntl qw(:flock);
use Time::HiRes qw(time usleep);
$| = 1;
my ($file, $timeout_ms) = @ARGV;
open(my $h, '>>', $file) or die "cannot open $file: $!";
my $end = time() + $timeout_ms / 1000;
while (1) {
  if (flock($h, LOCK_EX | LOCK_NB)) { print "locked\\n"; last; }
  if (time() >= $end) { print "busy\\n"; exit 1; }
  usleep(20000);
}
my $line = <STDIN>;
flock($h, LOCK_UN);
exit 0;
`;

export function acquireLock(file, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/perl', ['-e', HOLDER_SCRIPT, file, String(timeoutMs)], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    let settled = false;
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (settled) return;
      if (out.includes('locked')) {
        settled = true;
        let released = false;
        resolve(function release() {
          if (released) return;
          released = true;
          try { child.stdin.end(); } catch { /* already gone */ }
        });
      } else if (out.includes('busy')) {
        settled = true;
        reject(new Error('lock busy: ' + file));
      }
    });
    child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    child.on('exit', (code) => { if (!settled) { settled = true; reject(new Error('lock helper exited with ' + code)); } });
  });
}
