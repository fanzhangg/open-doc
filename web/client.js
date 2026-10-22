// The page's side of the order the doc host keeps (docs/architecture.md,
// Interfaces; docs/markdown-view.md, Many writers, plan A): the view's typing
// goes to the host as operations on the rev it started from, one edit at a
// time: at once when none is on its way, else all typed meanwhile once the
// host answers. Others' edits come back as operations, moved over the typing
// not landed yet and shown with the view's applyText. The same for every
// view, and for the two-writer harness (test/collab/page.js).

import { apply, diffOps, mapOffset, transform } from '../src/core/ot.js';

/**
 * Keep `view` ({ getText, selection }) in the host's order: `call(type,
 * arg)` asks the doc host (`state`, `submit`); `show(text, ops, event)`
 * shows others' edits, `ops` as they changed the view's text, `event` the
 * host's `ops` event (null for the edits of a host that started again);
 * `rules()`, the doc's rules (rulesOf), as the host judges an edit that
 * yields; `caughtUp(state)` hears the host's `state` each catch-up brings.
 * Start it with the host's `state`; call `edited()` on every change the
 * person makes in the view, and `moved()` when their caret moves; give it
 * each `ops` and `cursors` event, and `catchUp()` on a new connection.
 */
export function createClient({ view, call, show, rules, caughtUp = () => {}, onError = () => {} }) {
  const name = Math.random().toString(36).slice(2);
  let sends = 0;
  let epoch = null;
  let rev = 0;
  let confirmed = ''; // the host's text at `rev`
  let last = ''; // the view's text as last read: `confirmed` with `pending` on it
  let pending = []; // the view's edits not landed yet, each on the one before; the first sent once `sent`
  // The submit the first was sent as, { ops, rev, epoch, id }: `landed` once
  // the host says so, `refused` when it will not take it, `lost` when the
  // line dropped before it answered, so it is sent again as it was.
  let sent = null;
  let catching = null; // a catch-up on its way; events meanwhile wait in `held`
  let held = [];
  let idle = [];
  let cursors = []; // people's cursors: [{ id, name, at }], `at` in `confirmed`
  let caretMoved = false; // the person's caret moved since it was last sent
  let caretSent = false; // one is on its way
  let caretWas = null; // where the last one sent was: `at` on `rev`

  // The person's caret goes to the host on the text the host has: once
  // their typing has landed, one at a time, the latest.
  function sendCaret() {
    if (!caretMoved || caretSent || catching || pending.length > 0) return;
    caretMoved = false;
    const at = view.selection()?.to;
    if (at === undefined || caretWas === `${at}@${rev}`) return;
    caretWas = `${at}@${rev}`;
    caretSent = true;
    call('cursor', { at, rev, epoch }).catch(() => {}).finally(() => {
      caretSent = false;
      sendCaret();
    });
  }

  // The first edit not landed goes out, unless one is on its way.
  function next() {
    if (sent !== null || catching) return;
    if (pending.length > 0) {
      sent = { ops: pending[0], rev, epoch, id: `${name}.${++sends}` };
      post(sent);
    } else {
      for (const done of idle.splice(0)) done();
      sendCaret();
    }
  }

  // Its event comes before its answer, so an answer with no event says the
  // event was lost. An edit whose fate is not known is sent again as it
  // was, never moved: the host takes an id once.
  function post(submit) {
    call('submit', submit).then(() => {
      submit.landed = true;
      if (sent === submit) client.catchUp();
    }, (error) => {
      if (sent !== submit) return;
      if (error.code === 'offline') submit.lost = true; // sent again on the next connection
      else if (error.code === 'not_saved') onError(error); // landed: told once it is written
      else if (error.code === 'forbidden') onError(error); // not this page's to send (set to Read meanwhile)
      else {
        if (error.code !== 'stale') onError(error);
        submit.refused = true;
        client.catchUp();
      }
    });
  }

  // The view's typing since it was last read is pending too.
  function flush() {
    const text = view.getText();
    if (text === last) return;
    pending.push(diffOps(last, text, view.selection()?.to));
    last = text;
    next();
  }

  function take(event) {
    if (event.epoch !== epoch || event.rev <= rev) return; // a host gone, or already in the text
    if (event.rev > rev + 1) return client.catchUp(); // one was missed
    const ours = event.id !== null && event.id === sent?.id;
    if (!ours) flush(); // typing since the last read is on the rev before this one
    const was = confirmed;
    rev = event.rev;
    confirmed = apply(confirmed, event.ops);
    for (const cursor of cursors) cursor.at = mapOffset(cursor.at, event.ops);
    if (ours) {
      pending.shift();
      sent = null;
      flush(); // what was typed while it was on its way
      next();
      return;
    }
    if (event.yields && pending.length > 0) {
      // An edit that yields yields to the typing not landed, as the host
      // makes it: the edit on its way as the host will move it, the rest after.
      const moved = (ops) => transform(ops, event.ops, { landedYields: true, base: was, rules: rules() }).ops;
      const after = apply(confirmed, moved(diffOps(was, last)));
      if (sent !== null) {
        const first = moved(pending[0]);
        const rest = diffOps(apply(confirmed, first), after);
        pending = rest.length > 0 ? [first, rest] : [first];
      } else pending = [diffOps(confirmed, after)].filter((ops) => ops.length > 0);
      const shown = diffOps(last, after);
      last = after;
      show(last, shown, event);
      next();
      return;
    }
    const ops = over(event.ops);
    last = apply(last, ops);
    show(last, ops, event);
  }

  // Move the typing not landed over edit `ops`, which landed where it
  // started: `ops` as they change the view's text.
  function over(ops) {
    pending = pending.map((mine) => {
      const moved = transform(mine, ops).ops;
      ops = transform(ops, mine, { first: true }).ops;
      return moved;
    });
    return ops;
  }

  // Take the host's text again from `state`, where its log no longer
  // reaches back to this page's rev or its epoch is new: what landed since
  // is the difference from the text last confirmed, with the edit on its way
  // if it landed (a host started again says so in `landed`, when it is in
  // the file); the typing not landed, as it was typed, is moved over it.
  // False, and nothing changed, while the fate of the edit on its way is
  // not known.
  function retake(state) {
    let base = confirmed;
    if (sent !== null && (sent.landed || (state.epoch !== sent.epoch && state.landed?.includes(sent.id)))) base = apply(confirmed, pending.shift());
    else if (sent !== null && !sent.refused && state.epoch === sent.epoch) return false;
    sent = null;
    flush();
    const shown = over(diffOps(base, state.text));
    ({ epoch, rev } = state);
    confirmed = state.text;
    if (shown.length > 0) {
      last = apply(last, shown);
      show(last, shown, null);
    }
    return true;
  }

  const client = {
    start(state) {
      ({ epoch, rev, cursors = [] } = state);
      confirmed = last = state.text;
    },
    flush,
    /** The person changed the view: their typing goes out now, or once the edit on its way is answered. */
    edited() {
      if (sent === null && !catching) flush();
    },
    /** An `ops` event: an edit landed. */
    receive(event) {
      if (catching) held.push(event);
      else take(event);
    },
    /**
     * Catch up with the host: on a new connection, an `ops` event missed,
     * an edit refused as `stale`, or one answered whose event never came.
     * One `state` from this page's rev: the events missed, taken as they
     * would have been, or the text again (retake). Nothing changes before
     * it answers. Then an edit lost on the line goes again.
     */
    catchUp() {
      catching ??= (async () => {
        const state = await call('state', { since: { epoch, rev } });
        flush();
        if (state.events) for (const event of state.events) take(event);
        else if (!retake(state)) sent.lost = true;
        if (state.epoch === epoch && state.rev === rev) cursors = state.cursors ?? [];
        caughtUp(state);
      })().catch(onError).finally(() => {
        catching = null;
        for (const event of held.splice(0)) take(event);
        if (sent?.lost) {
          sent.lost = false;
          post(sent);
        } else flush();
        next();
      });
      return catching;
    },
    /** The person's caret moved: the host hears where, once their typing has landed. */
    moved() {
      caretMoved = true;
      sendCaret();
    },
    /** A `cursors` event: where each person's cursor is. */
    cursors(event) {
      if (event.epoch === epoch && event.rev === rev && !catching) cursors = event.cursors;
    },
    /** Where people's cursors are in the view's text as last read: [{ id, name, at }]. */
    cursorsShown: () => cursors.map((cursor) => ({ ...cursor, at: pending.reduce((at, ops) => mapOffset(at, ops), cursor.at) })),
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
