// @mentions of agents typed in the doc's text (SPEC.md §4.1). Each one the
// human adds is followed by an anchor on its `@name`, and sent as the human's
// comment (the text from the `@` to the end of its paragraph) once they are
// done writing it:
// - they moved on: their caret, or a change they saved, is in another
//   paragraph, or the editor lost focus;
// - the paragraph has been still for `idleMs` (as long as the human counts
//   as typing there, so an agent could not have edited it any sooner);
// - it ends a sentence (. ! ? 。 ！ ？ …) and has been still for `settleMs`.
// A bare `@name` with nothing after it waits for the human to move on.
//
// Until the agent answers, the comment stays bound to that text. When the
// human changes it, a run answering it is stopped, the thread is held back
// from the agents, and once the human is done again (by the same rules) the
// comment takes the new text and the agent starts over.

import { addedMentions, blockAt, carry, changedRanges, createAnchor, locate, project } from '../core/index.js';
import { sameName } from '../core/mentions.js';

const SENTENCE_END = /[.!?。！？…]$/u;
const MAX_ASKS = 50; // sent ones beyond this are forgotten first

export class TextAsks {
  /**
   * `mentionable()` names the agents a mention can reach; `text()` reads
   * the doc's rendered text. `send({ name, text, start, end })` adds the ask
   * as the human's comment and returns `{ threadId, messageId }` (null when
   * it cannot). `open(threadId, messageId)` says whether that message is
   * still the thread's last, unanswered. `rebind({ threadId, messageId, text,
   * start, end })` gives it the ask's new text; `release()` lets the agents
   * look again.
   */
  constructor({ idleMs, settleMs, mentionable, text, send, open, rebind, release, onError = (error) => console.error('Could not follow an @mention in the doc:', error) }) {
    Object.assign(this, { idleMs, settleMs, mentionable, text, send, open, rebind, release, onError });
    // { name, token: anchor of its `@name`, at, seen: the text `at` is in,
    //   touched: when its paragraph last changed, left: the human moved on
    //   since, thread: { id, messageId, quote } once sent, held }
    this.asks = [];
    this.caretAt = undefined; // anchor of the paragraph the caret is in; null: none (no focus); undefined: not known
    this.queue = Promise.resolve();
    this.timer = null;
    this.stopped = false;
  }

  /** The human saved the doc from markdown `before` to `after`. */
  humanSaved(before, after) {
    this.#enqueue(() => this.#saved(before, after));
  }

  /** The human's caret is in the paragraph `anchor` points at, or in none (null). */
  caret(anchor) {
    this.caretAt = anchor;
    this.#enqueue(() => this.#review());
  }

  /** Whether agents should leave thread `threadId` alone: the human is rewriting its ask. */
  held(threadId) {
    return this.asks.some((a) => a.held && a.thread.id === threadId);
  }

  /** Resolves once the work queued so far is done. */
  settled() {
    return this.queue;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  #enqueue(fn) {
    if (this.stopped) return;
    this.queue = this.queue.then(() => (this.stopped ? null : fn())).catch((error) => this.onError(error));
  }

  async #saved(before, after) {
    const was = project(before).text;
    const now = project(after).text;
    if (was === now) return;
    const changes = changedRanges(was, now);
    const time = Date.now();
    for (const ask of [...this.asks]) {
      const from = ask.seen === was ? ask.at : locate(was, ask.token)?.start;
      const at = from === undefined ? null : carry(changes, from, from + 1 + ask.name.length);
      if (at === null || now[at] !== '@' || !sameName(now.slice(at + 1, at + 1 + ask.name.length), ask.name)) {
        this.#drop(ask); // the human changed or removed the mention itself
        continue;
      }
      this.#place(ask, now, at);
      const block = blockAt(now, at);
      if (!changes.some((c) => c.b0 <= block.end && c.b1 >= block.start)) {
        if (!ask.thread || ask.held) ask.left = true;
        continue;
      }
      ask.touched = time;
      ask.left = false;
      if (!ask.thread || ask.held) continue;
      if (quoteAt(now, at) === ask.thread.quote) continue;
      // Sent, and the human is rewriting it: hold it back until they are done.
      if (!(await this.open(ask.thread.id, ask.thread.messageId))) {
        this.#drop(ask);
        continue;
      }
      ask.held = true;
    }
    const names = after.includes('@') ? await this.mentionable() : [];
    for (const m of addedMentions(before, after, names)) {
      if (this.asks.some((a) => a.seen === now && a.at === m.start)) continue;
      const ask = { name: m.name, touched: time, left: false, thread: null, held: false };
      this.#place(ask, now, m.start);
      this.asks.push(ask);
    }
    const sent = this.asks.filter((a) => a.thread && !a.held);
    for (const ask of sent.slice(0, Math.max(0, this.asks.length - MAX_ASKS))) this.#drop(ask);
    await this.#review();
  }

  // Send each ask the human is done writing; come back for the rest when
  // the first of them would be done.
  async #review() {
    clearTimeout(this.timer);
    const waiting = this.asks.filter((a) => !a.thread || a.held);
    if (waiting.length === 0) return;
    const text = await this.text();
    const time = Date.now();
    let next = Infinity;
    for (const ask of waiting) {
      const at = ask.seen === text ? ask.at : locate(text, ask.token)?.start;
      if (at === undefined || !sameName(text.slice(at + 1, at + 1 + ask.name.length), ask.name)) {
        this.#drop(ask);
        continue;
      }
      this.#place(ask, text, at);
      const block = blockAt(text, at);
      const quote = quoteAt(text, at);
      const bare = quote.length === 1 + ask.name.length;
      const due = bare ? Infinity : ask.touched + (SENTENCE_END.test(quote) ? this.settleMs : this.idleMs);
      if (ask.left || this.#caretLeft(text, block) || time >= due) await this.#done(ask, text, at, quote);
      else next = Math.min(next, due);
    }
    if (next < Infinity) this.timer = setTimeout(() => this.#enqueue(() => this.#review()), next - time);
  }

  async #done(ask, text, at, quote) {
    const end = at + quote.length;
    if (!ask.thread) {
      const sent = await this.send({ name: ask.name, text, start: at, end });
      if (!sent) return this.#drop(ask);
      ask.thread = { id: sent.threadId, messageId: sent.messageId, quote };
      return;
    }
    if (!(await this.open(ask.thread.id, ask.thread.messageId))) return this.#drop(ask);
    await this.rebind({ threadId: ask.thread.id, messageId: ask.thread.messageId, text, start: at, end });
    ask.thread.quote = quote;
    ask.held = false;
    ask.left = false;
    await this.release();
  }

  // Whether the caret is known to be out of `block`: in no paragraph, or in another.
  #caretLeft(text, block) {
    if (this.caretAt === undefined) return false;
    if (this.caretAt === null) return true;
    const found = locate(text, this.caretAt);
    return Boolean(found) && (found.end < block.start || found.start > block.end);
  }

  #place(ask, text, at) {
    ask.token = createAnchor(text, at, at + 1 + ask.name.length);
    ask.at = at;
    ask.seen = text;
  }

  #drop(ask) {
    const i = this.asks.indexOf(ask);
    if (i === -1) return;
    this.asks.splice(i, 1);
    if (ask.held) this.release();
  }
}

// The ask a mention at `at` makes: from the `@` to the end of its block.
function quoteAt(text, at) {
  return text.slice(at, blockAt(text, at).end).trimEnd();
}

