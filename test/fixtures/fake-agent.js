// A stand-in for an agent CLI (docs/agent-config.md): it reads the prompt
// on stdin, edits the doc's copy at OPENDOC_DOC and prints its reply. What it
// does comes from the latest comment in the prompt's thread:
//   replace "<before>" with "<after>"   edit the copy
//   hold                                wait for $FAKE_DIR/release-<buddy> first
//   fail                                print to stderr and exit 1
//   say <text>                          reply <text>
// Each run logs one JSON line to $FAKE_DIR/runs.log when it starts.

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const thread = prompt.match(/<thread>\n([\s\S]*?)\n<\/thread>/)?.[1] ?? '';
const ask = thread.split('\n\n').at(-1) ?? '';
const { OPENDOC_DOC: doc, OPENDOC_PROJECT: project, OPENDOC_BUDDY: buddy, FAKE_DIR: dir } = process.env;
const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && ['opendoc', 'opendoc.cmd'].some((f) => existsSync(join(d, f))));
appendFileSync(join(dir, 'runs.log'), JSON.stringify({ buddy, ask, cwd: process.cwd(), files: readdirSync(process.cwd()), doc, project, prompt, opendoc: onPath }) + '\n');

if (/\bhold\b/.test(ask)) {
  while (!existsSync(join(dir, `release-${buddy}`))) await new Promise((r) => setTimeout(r, 50));
}
if (/\bfail\b/.test(ask)) {
  console.log('some output');
  console.error('fake agent: something went wrong');
  process.exit(1);
}
const edit = ask.match(/replace "(.*?)" with "(.*?)"/);
if (edit) writeFileSync(doc, readFileSync(doc, 'utf8').replace(edit[1], edit[2]));
const said = ask.match(/\bsay (.*)/)?.[1];
console.log(said ?? (edit ? `Replaced "${edit[1]}".` : 'Nothing to change.'));
