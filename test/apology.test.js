import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apology } from '../web/apology.js';

test('an agent apologizes in a few words that name what went wrong', () => {
  assert.equal(apology('could not run C:/nope/claude.exe: spawn C:/nope/claude.exe ENOENT', 'claude'), "Sorry, I can't find Claude Code.");
  assert.equal(apology('Codex was not found; install it', 'codex'), "Sorry, I can't find Codex.");
  assert.equal(apology('could not start the agent: spawn mybot ENOENT', 'custom'), "Sorry, I can't find my program.");
  assert.equal(apology('Claude Code is not signed in; run "claude" once', 'claude'), "Sorry, I'm not signed in to Claude Code.");
  assert.equal(apology('timed out after 10 min', 'claude'), 'Sorry, I timed out after 10 min.');
  assert.equal(apology('finished without replying to a comment'), 'Sorry, I finished without replying.');
  assert.equal(apology('error_max_turns', 'claude'), 'Sorry, I ran out of turns.');
  assert.equal(apology('usage limit reached', 'codex'), 'Sorry, I hit my usage limit.');
  assert.equal(apology('exited with code 1: fake agent: something went wrong', 'custom'), 'Sorry, my program crashed (exit code 1).');
  assert.equal(apology('API Error: 500 overloaded', 'claude'), 'Sorry, my run failed: API Error: 500 overloaded');
  assert.equal(apology(undefined), 'Sorry, my run failed.');
});
