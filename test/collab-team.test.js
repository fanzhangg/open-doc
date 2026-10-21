// The two-writer cases (test/collab.test.js) with the owner in a window of
// the app and a teammate who can edit in a browser page, reaching the
// owner's doc host through the relay, run locally (test/relay/harness.js).

import { after } from 'node:test';
import { startRelay } from './relay/harness.js';

const relay = await startRelay();
after(() => relay.stop());
process.env.COLLAB_RELAY = relay.url;
await import('./collab.test.js');
