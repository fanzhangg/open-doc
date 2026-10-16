// A stand-in for a headless agent, launched by the dispatcher through a custom
// command: fake-agent.js <threadsFile> <mode> <runLog> [promptFile]
// Modes: reply, slow, edit, edit-slow (edits, then waits before replying),
// propose, picky (passes on an open comment, one that mentions no one,
// unless it names the agent), fail, hang, silent (exits 0 without
// replying). Doc Watcher modes, for runs handed `changes`: watch (does
// nothing with them), watch-edit (adds a line to the doc and comments on it),
// watch-edit-silent (adds the line without a comment). It calls `opendoc`
// through a shell to prove the dispatcher's PATH shim works. Each run logs
// when it starts and ends, the asks and changes it was handed, and the
// persona in its prompt (when given the prompt file).

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const [threadsFile, mode, runLog, promptFile] = process.argv.slice(2);
const { doc, threads, changes } = JSON.parse(readFileSync(threadsFile, 'utf8'));
const persona = promptFile ? readFileSync(promptFile, 'utf8').match(/<persona>\n([\s\S]*?)\n<\/persona>/)?.[1] ?? null : undefined;
appendFileSync(runLog, JSON.stringify({ threads: threads.map((t) => t.id), asks: threads.map((t) => t.messages.findLast((m) => m.author.kind === 'human')?.body ?? null), changes: changes ?? null, as: process.env.OPENDOC_AS, cwd: process.cwd(), doc, persona, start: Date.now() }) + '\n');

if (changes && mode.startsWith('watch-edit')) {
  const text = readFileSync(doc, 'utf8');
  const line = `Seen by ${process.env.OPENDOC_AS} ${(text.match(/Seen by/g) ?? []).length + 1}`;
  writeFileSync(doc, `${text.trimEnd()}\n\n${line}\n`);
  if (mode === 'watch-edit') execSync(`opendoc comment "${doc}" --quote "${line}" "Noted the change"`, { stdio: 'ignore' });
}

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
    if (mode === 'picky' && thread.open) {
      const ask = thread.messages.findLast((m) => m.author.kind === 'human').body.toLowerCase();
      if (!ask.includes(process.env.OPENDOC_AS.toLowerCase())) continue;
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
