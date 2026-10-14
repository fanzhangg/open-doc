// Writer process for the concurrency test: append N replies to one thread.
import { applyOp, newId } from '../../src/core/index.js';
import { update } from '../../src/store/files.js';

const [docPath, threadId, writer, count] = process.argv.slice(2);
const author = { name: writer, kind: 'agent' };
for (let i = 0; i < Number(count); i++) {
  await update(docPath, (s) => applyOp(s, {
    type: 'addMessage',
    threadId,
    message: { id: newId('m'), author, body: `${writer}-${i}`, createdAt: new Date().toISOString() },
  }));
}
