// A stand-in for an agent CLI (docs/agent-config.md): it reads the prompt
// on stdin, edits the doc's copy at OPENDOC_DOC and prints its reply. What it
// does comes from the latest comment in the prompt's thread:
//   replace "<before>" with "<after>"   edit the copy
//   hold                                wait for $FAKE_DIR/release-<buddy> first
//   fail                                print to stderr and exit 1
//   say <text>                          reply <text>
//   quiet                               reply nothing
//   append <json>                       append a line to the sidecar's copy
//   reply-first <text>                  append a reply in the sidecar's first thread
//   resolve                             append the line the prompt gives to resolve the run's thread
//   tamper                              change the first comment's line, and append one that resolves its thread
// Commands after the first may follow `;;`.
// Each run logs one JSON line to $FAKE_DIR/runs.log when it starts, with
// the OPENDOC_SETTING_* it was given.

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const thread = prompt.match(/<thread>\n([\s\S]*?)\n<\/thread>/)?.[1] ?? '';
const ask = thread.split('\n\n').at(-1) ?? '';
const { OPENDOC_DOC: doc, OPENDOC_COMMENTS: comments, OPENDOC_PROJECT: project, OPENDOC_BUDDY: buddy, FAKE_DIR: dir } = process.env;
const settings = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('OPENDOC_SETTING_')));
const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && ['opendoc', 'opendoc.cmd'].some((f) => existsSync(join(d, f))));
appendFileSync(join(dir, 'runs.log'), JSON.stringify({ buddy, ask, cwd: process.cwd(), files: readdirSync(process.cwd()), doc, comments, project, prompt, settings, opendoc: onPath }) + '\n');

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
const lines = readFileSync(comments, 'utf8').split('\n');
const first = lines.slice(1).find(Boolean);
for (const command of ask.split(';;').map((c) => c.trim())) {
  const json = command.match(/\bappend (\{.*\})$/)?.[1];
  if (json) appendFileSync(comments, `${json}\n`);
  const answer = command.match(/\breply-first (.*)$/)?.[1];
  if (answer) appendFileSync(comments, `${JSON.stringify({ thread: JSON.parse(first).id, body: answer })}\n`);
  if (/\bresolve$/.test(command)) appendFileSync(comments, `${prompt.match(/\{"thread":"c_[^"]+","resolved":true\}/)[0]}\n`);
  if (/\btamper$/.test(command)) {
    const changed = lines.map((l) => (l === first ? JSON.stringify({ ...JSON.parse(l), body: 'Tampered.' }) : l)).join('\n');
    writeFileSync(comments, `${changed}${JSON.stringify({ thread: JSON.parse(first).id, body: 'Closing.', resolved: true })}\n`);
  }
}
const said = ask.match(/\bsay (.*)/)?.[1];
if (!/\bquiet\b/.test(ask)) console.log(said ?? (edit ? `Replaced "${edit[1]}".` : 'Nothing to change.'));
