// The page's line to the doc host in a plain browser: through the relay
// (relay/worker.js; docs/architecture.md, Sharing), with the same
// `{ call, onEvent }` the app's preload gives a window (window.ponjoHost),
// and `onLine`, how the line is. The relay is at the page's own origin,
// which serves it; the page's address names the room and maybe the doc:
// `?room=<room>&doc=<path in the project>`. The line's first message names
// the doc and who the page is, as `identity()` says when the first call
// makes it; nothing of it goes in an address. Calls wait for the host's
// first `hello`; after it, one made, or on its way, while the line is down
// fails as `offline`: nothing is kept to send later. A line that drops, or
// leaves a ping unanswered (one each PING_MS), is made again, after
// 2 seconds and twice as long each time up to 30 (a page left open while
// the host sleeps costs the relay little), and the host's `hello` on it
// catches the page up, unless the host turned the page away: then every
// call fails with the host's reason.

const RETRY_MS = 2000;
const MAX_RETRY_MS = 30_000;
// A line that drops, half-open too, is noticed within 2 × PING_MS.
const PING_MS = 5000;
const HOST_AWAY = 4000; // the relay: no host in the room (relay/worker.js)
const TURNED_AWAY = 4001; // the host, with its reason

/**
 * The doc host reached through the relay at `relay` (a ws: or wss: URL),
 * in the room the page's `params` name, as `identity()`: { key, made once
 * in this browser; name }.
 */
export function relayHost(relay, params, identity) {
  let socket = null;
  let retry = RETRY_MS;
  let online = false; // the host said hello on this line
  let served = false; // and on some line before
  let refused = null; // the host's reason for turning the page away
  let nextCall = 0;
  const calls = new Map(); // sent: id → its resolve
  const unsent = []; // before the first hello: { id, type, arg, done }
  let listener = null;
  const early = [];
  let showLine = () => {};
  let line = null;
  const setLine = (next) => {
    if (next?.reason !== line?.reason) showLine(next);
    line = next;
  };

  function connect() {
    const ws = new WebSocket(`${relay}/rooms/${params.get('room')}`);
    socket = ws;
    let heard = 0; // when it last said anything
    let pinged = 0; // when it was last pinged
    let gone = false;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ ...(params.get('doc') ? { doc: params.get('doc') } : {}), ...identity() })));
    const beat = setInterval(() => {
      if (pinged > heard) lost({}); // the last ping went unanswered: a half-open line
      else if (ws.readyState === WebSocket.OPEN) {
        pinged = Date.now();
        ws.send('ping');
      }
    }, PING_MS);
    ws.addEventListener('message', ({ data }) => {
      if (gone) return;
      heard = Date.now();
      if (data === 'pong') return;
      const message = JSON.parse(data);
      if (message.event === 'hello') {
        online = served = true;
        retry = RETRY_MS;
        setLine(null);
        for (const request of unsent.splice(0)) send(request);
      }
      if (message.event) return listener ? listener(message.event, message.data) : early.push([message.event, message.data]);
      calls.get(message.id)?.(message.error ? { error: message.error } : { result: message.result });
      calls.delete(message.id);
    });
    // A line not made fires `error` alone in some browsers, `error` and `close` in others.
    const lost = ({ code, reason }) => {
      if (gone) return;
      gone = true;
      clearInterval(beat);
      ws.close();
      online = false;
      if (code === TURNED_AWAY) {
        refused = { message: REFUSED[reason] ?? 'The host turned this page away', code: reason };
        for (const done of [...calls.values(), ...unsent.splice(0).map((r) => r.done)]) done({ error: refused });
        calls.clear();
        return setLine({ reason: 'refused', ...refused });
      }
      for (const done of calls.values()) done({ error: OFFLINE });
      calls.clear();
      setLine({ reason: code === HOST_AWAY ? (served ? 'host' : 'nohost') : 'relay' });
      setTimeout(connect, retry);
      retry = Math.min(2 * retry, MAX_RETRY_MS);
    };
    ws.addEventListener('error', () => setTimeout(() => lost({}), 100)); // its `close`, if one comes, says more
    ws.addEventListener('close', lost);
  }

  function send({ done, ...request }) {
    calls.set(request.id, done);
    socket.send(JSON.stringify(request));
  }

  return {
    call: (type, arg) => new Promise((done) => {
      if (!socket) connect();
      const request = { id: ++nextCall, type: String(type), arg, done };
      if (refused) done({ error: refused });
      else if (online) send(request);
      else if (served) done({ error: OFFLINE });
      else unsent.push(request);
    }),
    onEvent(fn) {
      listener = fn;
      for (const [event, data] of early.splice(0)) fn(event, data);
    },
    /**
     * `fn(line)` hears how the line is: null once the host is in, else
     * `{ reason }`, 'host' (it went away), 'nohost' (it was never in: the
     * room may have closed), 'relay' (the relay cannot be reached, or the
     * line said nothing for too long), or 'refused' with the host's
     * `message` and `code`.
     */
    onLine(fn) {
      showLine = fn;
      if (line) fn(line);
    },
  };
}

const OFFLINE = { message: 'The host is offline', code: 'offline' };

/** Why the host turns a page away (desktop/doc-host.js, src/host/room.js), as the page says it. */
export const REFUSED = {
  closed: 'The host closed the room',
  kicked: 'The host removed you from this room',
  locked: 'The room is locked: no one new can join',
  not_found: 'This doc is not in the shared project',
  hidden: 'Names starting with . and paths out of the project are never shared',
  bad_input: 'This page could not say who you are',
  full: 'Too many people are in this room at once',
};
