// A stand-in for a headless agent, launched by the dispatcher through a custom
// command: fake-agent.js <threadsFile> <mode> <runLog>
// Modes: reply, slow, edit, propose, fail, hang, silent (exits 0 without
// replying). It calls `opendoc` through a shell to prove the dispatcher's
// PATH shim works.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const [threadsFile, mode, runLog] = process.argv.slice(2);
const { doc, threads } = JSON.parse(readFileSync(threadsFile, 'utf8'));
appendFileSync(runLog, JSON.stringify({ threads: threads.map((t) => t.id), as: process.env.OPENDOC_AS, cwd: process.cwd() }) + '\n');

if (mode === 'fail') {
  console.error('fake agent: something went wrong');
  process.exit(1);
}
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode !== 'silent') {
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 1500));
  if (mode === 'edit') writeFileSync(doc, readFileSync(doc, 'utf8').replace('extra load', 'extra peak load'));
  for (const thread of threads) {
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
