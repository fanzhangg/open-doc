// A stand-in for a headless agent, launched by the dispatcher through a custom
// command: fake-agent.js <threadsFile> <mode> <runLog> [promptFile]
// Modes: reply, slow, edit, edit-slow (edits, then waits before replying),
// propose, ask (asks the guard to read a file beyond the doc, as Claude
// Code's hook would, and replies with the answer), fail, hang, silent (exits 0 without
// replying). It calls `opendoc` through a shell to prove the dispatcher's
// PATH shim works. Each run logs when it starts and ends, and the persona in
// its prompt (when given the prompt file).

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const [threadsFile, mode, runLog, promptFile] = process.argv.slice(2);
const { doc, threads } = JSON.parse(readFileSync(threadsFile, 'utf8'));
const persona = promptFile ? readFileSync(promptFile, 'utf8').match(/<persona>\n([\s\S]*?)\n<\/persona>/)?.[1] ?? null : undefined;
appendFileSync(runLog, JSON.stringify({ threads: threads.map((t) => t.id), as: process.env.OPENDOC_AS, cwd: process.cwd(), doc, persona, start: Date.now() }) + '\n');

if (mode === 'fail') {
  console.error('fake agent: something went wrong');
  process.exit(1);
}
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode !== 'silent') {
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 1500));
  if (mode === 'edit' || mode === 'edit-slow') writeFileSync(doc, readFileSync(doc, 'utf8').replace('extra load', 'extra peak load'));
  if (mode === 'edit-slow') await new Promise((r) => setTimeout(r, 1500));
  for (const thread of threads) {
    if (mode === 'ask') {
      // What Claude Code does before a Read outside the doc: run the guard
      // hook with the tool call on stdin; it may wait for the human.
      const call = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(dirname(doc), 'notes', 'q3.md') } };
      const out = execSync('opendoc guard', { input: JSON.stringify(call), encoding: 'utf8' }).trim();
      const verdict = out ? JSON.parse(out).hookSpecificOutput : { permissionDecision: 'none' };
      appendFileSync(runLog, JSON.stringify({ hook: verdict, as: process.env.OPENDOC_AS }) + '\n');
      execSync(`opendoc reply "${doc}" ${thread.id} "Read ${verdict.permissionDecision}"`, { stdio: 'inherit' });
      continue;
    }
    if (mode === 'propose') {
      const input = JSON.stringify({ body: 'Suggest adding "peak".', changes: [{ before: 'extra load', after: 'extra peak load' }] });
      execSync(`opendoc propose "${doc}" ${thread.id}`, { input, stdio: ['pipe', 'inherit', 'inherit'] });
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
