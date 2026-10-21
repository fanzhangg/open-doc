// The page's side of the order the doc host keeps (docs/architecture.md,
// Interfaces; docs/markdown-view.md, Many writers, plan A): the view's typing
// goes to the host as operations on the rev it started from, one edit at a
// time, and others' edits come back as operations, moved over the typing not
// landed yet and shown with the view's applyText. The same for every view,
// and for the two-writer harness (test/collab/page.js).

import { apply, diffOps, transform } from '../src/core/ot.js';

/**
 * Keep `view` ({ getText, selection }) in the host's order: `call(type,
 * arg)` asks the doc host (`state`, `submit`); `show(text, ops, event)`
 * shows others' edits, `ops` as they changed the view's text, `event` the
 * host's `ops` event (null for the edits of a host that started again);
 * `rules()`, the doc's rules (rulesOf), as the host judges an edit that
 * yields. Start it with the host's `state`; give it each `ops` event, and
 * `resync()` on a new connection.
 */
export function createClient({ view, call, show, rules, onError = () => {} }) {
  const name = Math.random().toString(36).slice(2);
  let sends = 0;
  let epoch = null;
  let rev = 0;
  let confirmed = ''; // the host's text at `rev`
  let last = ''; // the view's text as last read: `confirmed` with `pending` on it
  let pending = []; // the view's edits not landed yet, each on the one before; the first sent once `sent`
  let sent = null; // the id the first was sent with
  let answer = null; // resolves to whether it landed, once the host answers
  let syncing = null; // a resync on its way; events meanwhile wait in `held`
  let held = [];
  let idle = [];

  function send() {
    const id = `${name}.${++sends}`;
    sent = id;
    answer = call('submit', { ops: pending[0], rev, epoch, id }).then(() => true, (error) => {
      if (id !== sent) return false; // sent again since
      // An edit the host would not take (an epoch or rev it no longer has):
      // take its text again, and send the edit on that.
      if (error.code !== 'stale') onError(error);
      client.resync({ stale: true });
      return false;
    });
  }

  function settle() {
    if (pending.length > 0) return;
    for (const done of idle.splice(0)) done();
  }

  // The view's typing since it was last read is pending too.
  function flush() {
    const text = view.getText();
    if (text === last) return;
    pending.push(diffOps(last, text, view.selection()?.to));
    last = text;
    if (sent === null && !syncing) send();
  }

  function take(event) {
    if (event.epoch !== epoch || event.rev <= rev) return; // a host gone, or already in the text
    if (event.rev > rev + 1) return client.resync({ missed: true }); // one was missed
    const ours = sent !== null && event.id === sent;
    if (!ours) flush(); // typing since the last read is on the rev before this one
    const was = confirmed;
    rev = event.rev;
    confirmed = apply(confirmed, event.ops);
    if (ours) {
      pending.shift();
      sent = null;
      if (pending.length > 0) send();
      else settle();
      return;
    }
    if (event.yields && pending.length > 0) {
      // An edit that yields yields to the typing not landed, as the host
      // makes it: the edit on its way as the host will move it, the rest after.
      const moved = (ops) => transform(ops, event.ops, { landedYields: true, base: was, rules: rules() }).ops;
      const next = apply(confirmed, moved(diffOps(was, last)));
      if (sent !== null) {
        const first = moved(pending[0]);
        const rest = diffOps(apply(confirmed, first), next);
        pending = rest.length > 0 ? [first, rest] : [first];
      } else pending = [diffOps(confirmed, next)].filter((ops) => ops.length > 0);
      const shown = diffOps(last, next);
      last = next;
      show(last, shown, event);
      if (sent === null) {
        if (pending.length > 0) send();
        else settle();
      }
      return;
    }
    let ops = event.ops;
    pending = pending.map((mine) => {
      const moved = transform(mine, ops).ops;
      ops = transform(ops, mine, { first: true }).ops;
      return moved;
    });
    last = apply(last, ops);
    show(last, ops, event);
  }

  const client = {
    start(state) {
      ({ epoch, rev } = state);
      confirmed = last = state.text;
    },
    flush,
    /** An `ops` event: an edit landed. */
    receive(event) {
      if (syncing) held.push(event);
      else take(event);
    },
    /**
     * Take the host's text again: on a new connection (only if the host
     * started again, a new epoch), on an edit refused as `stale`, or when an
     * `ops` event was `missed`. What landed since is the difference from the
     * text last confirmed, with the edit on its way if it landed meanwhile;
     * the typing not landed is moved over it and sent as one edit.
     */
    resync({ stale = false, missed = false } = {}) {
      syncing ??= (async () => {
        let base = confirmed;
        if (missed && sent !== null && await answer) { // it landed, among the edits missed
          base = apply(confirmed, pending.shift());
          sent = null;
        }
        const state = await call('state');
        if (stale || missed || state.epoch !== epoch) {
          flush();
          const landed = diffOps(base, state.text);
          const mine = diffOps(base, last, view.selection()?.to);
          const moved = transform(mine, landed).ops;
          const shown = transform(landed, mine, { first: true }).ops;
          ({ epoch, rev } = state);
          confirmed = state.text;
          pending = moved.length > 0 ? [moved] : [];
          sent = null;
          if (shown.length > 0) {
            last = apply(last, shown);
            show(last, shown, null);
          }
          if (pending.length > 0) send();
          else settle();
        }
      })().catch(onError).finally(() => {
        syncing = null;
        for (const event of held.splice(0)) client.receive(event);
      });
      return syncing;
    },
    /** Resolves once all the view's typing so far has landed (and is written). */
    landed() {
      flush();
      return pending.length === 0 ? Promise.resolve() : new Promise((done) => idle.push(done));
    },
    /** Whether all the view's typing has landed. */
    idle: () => pending.length === 0 && view.getText() === last,
  };
  return client;
}
