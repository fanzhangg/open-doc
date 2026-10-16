// A stand-in for Claude Code or Codex in program checks (programStatus). A
// script cannot be started as a program on Windows, so tests use node itself
// as the program and load this first: NODE_OPTIONS="--require fake-program.cjs".
// Node answers `--version`; this answers `auth status` (Claude Code) and
// `login status` (Codex) as the real ones do, signed in when FAKE_PROGRAM is
// "signed-in". Any other node process it is loaded into runs as usual.

const { basename } = require('node:path');

const [command, sub] = [basename(process.argv[1] ?? ''), process.argv[2]];
const signedIn = process.env.FAKE_PROGRAM === 'signed-in';
if (command === 'auth' && sub === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none' }) + '\n');
  process.exit(signedIn ? 0 : 1);
}
if (command === 'login' && sub === 'status') {
  process.stderr.write(signedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
  process.exit(signedIn ? 0 : 1);
}
