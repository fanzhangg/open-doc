// A stand-in for a headless agent, launched by the dispatcher through a custom
// command: fake-agent.js <threadsFile> <mode> <runLog> [promptFile]
// Modes: reply, slow, edit, edit-slow (edits, then waits before replying),
// guarded-edit (makes the edit the ask names for it, `<name>: "<before>" ->
// "<after>"`, between the guard's hooks as a Claude Code run would, then
// waits before replying), propose, picky (passes on an open comment, one that mentions no one,
// unless it names the agent), handoff (replies as the human's latest message
// says for it: `<name> hands to <other>` hands the thread to <other> with
// --to, `<name> mentions <other>` only @mentions <other>), fail, boom (fails
// when a comment says "boom", else replies), hang, silent (exits 0 without
// replying). It calls `opendoc` through a shell to prove the dispatcher's
// PATH shim works. Each run logs when it starts and ends, the asks it was
// handed, and the persona in its prompt (when given the prompt file).

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const [threadsFile, mode, runLog, promptFile] = process.argv.slice(2);
const { doc, threads } = JSON.parse(readFileSync(threadsFile, 'utf8'));
const persona = promptFile ? readFileSync(promptFile, 'utf8').match(/<persona>\n([\s\S]*?)\n<\/persona>/)?.[1] ?? null : undefined;
appendFileSync(runLog, JSON.stringify({ threads: threads.map((t) => t.id), asks: threads.map((t) => t.messages.findLast((m) => m.author.kind === 'human')?.body ?? null), as: process.env.OPENDOC_AS, cwd: process.cwd(), doc, persona, start: Date.now() }) + '\n');

const boom = mode === 'boom' && threads.some((t) => t.messages.findLast((m) => m.author.kind === 'human').body.includes('boom'));
if (mode === 'fail' || boom) {
  console.error('fake agent: something went wrong');
  process.exit(1);
}
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode !== 'silent') {
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 1500));
  if (mode === 'edit' || mode === 'edit-slow') writeFileSync(doc, readFileSync(doc, 'utf8').replace('extra load', 'extra peak load'));
  if (mode === 'edit-slow') await new Promise((r) => setTimeout(r, 1500));
  if (mode === 'guarded-edit') {
    for (const thread of threads) {
      const ask = thread.messages.findLast((m) => m.author.kind === 'human').body;
      const named = ask.match(new RegExp(`${process.env.OPENDOC_AS}: "(.*?)" -> "(.*?)"`));
      if (named) guardedEdit(named[1], named[2]);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  for (const thread of threads) {
    if (mode === 'picky' && thread.open) {
      const ask = thread.messages.findLast((m) => m.author.kind === 'human').body.toLowerCase();
      if (!ask.includes(process.env.OPENDOC_AS.toLowerCase())) continue;
    }
    if (mode === 'propose') {
      const input = JSON.stringify({ body: 'Suggest adding "peak".', changes: [{ before: 'extra load', after: 'extra peak load' }] });
      execSync(`opendoc propose "${doc}" ${thread.id}`, { input, stdio: ['pipe', 'inherit', 'inherit'] });
      continue;
    }
    if (mode === 'handoff') {
      const ask = thread.messages.findLast((m) => m.author.kind === 'human').body;
      const hands = ask.match(new RegExp(`\\b${process.env.OPENDOC_AS} hands to (\\w+)`));
      const mentions = ask.match(new RegExp(`\\b${process.env.OPENDOC_AS} mentions (\\w+)`));
      // A refused handoff (too many in a row) is logged; the agent then replies without it.
      let handed = false;
      try {
        if (hands) execSync(`opendoc reply "${doc}" ${thread.id} "Your turn" --to ${hands[1]}`, { stdio: 'pipe' });
        handed = Boolean(hands);
      } catch (error) {
        appendFileSync(runLog, JSON.stringify({ handoffRefused: error.stderr.toString().trim(), as: process.env.OPENDOC_AS }) + '\n');
      }
      if (!handed) {
        execSync(`opendoc reply "${doc}" ${thread.id} "${mentions ? `@${mentions[1]} 4 points` : 'Handled by fake agent'}"`, { stdio: 'inherit' });
      }
      continue;
    }
    execSync(`opendoc reply "${doc}" ${thread.id} "Handled by fake agent"`, { stdio: 'inherit' });
    if (mode === 'edit') {
      // An agent may not resolve; record that the CLI refused.
      let refused = false;
      try {
        execSync(`opendoc resolve "${doc}" ${thread.id}`, { stdio: 'ignore' });
      } catch {
        refused = true;
      }
      appendFileSync(runLog, JSON.stringify({ resolveRefused: refused }) + '\n');
    }
  }
}
if (mode !== 'hang') appendFileSync(runLog, JSON.stringify({ end: Date.now(), as: process.env.OPENDOC_AS }) + '\n');

// An Edit as a Claude Code run with the guard's hooks makes it: `opendoc
// guard` before (which may refuse it, or hold it while another agent
// writes), then the edit, then `opendoc guard` after.
function guardedEdit(before, after) {
  const hook = (event) => execSync('opendoc guard', {
    input: JSON.stringify({ hook_event_name: event, tool_name: 'Edit', cwd: process.cwd(), tool_input: { file_path: doc, old_string: before, new_string: after } }),
  }).toString();
  const asked = Date.now();
  const verdict = hook('PreToolUse');
  const refused = verdict ? JSON.parse(verdict).hookSpecificOutput.permissionDecision === 'deny' : false;
  if (!refused) writeFileSync(doc, readFileSync(doc, 'utf8').replace(before, after));
  const edited = Date.now();
  if (!refused) hook('PostToolUse');
  appendFileSync(runLog, JSON.stringify({ edit: before, as: process.env.OPENDOC_AS, refused, asked, edited, done: Date.now() }) + '\n');
}
