// The page's line to the doc host in a plain browser: through the relay
// (relay/worker.js; docs/architecture.md, Sharing), with the same
// `{ call, onEvent }` the app's preload gives a window (window.opendocHost),
// and `onLine`, how the line is. The page's address names the relay, the
// room and maybe the doc: `?relay=<ws: or wss: URL>&room=<room>&doc=<path in
// the project>`; the line names who the page is, as `identity()` says when
// the first call makes it. Calls wait for the host's `hello`, which comes
// once the owner lets the teammate in; one on its way when the line drops
// fails as `offline`. The line is made again every few seconds, and the
// host's `hello` on it resyncs the page, unless the host turned the page
// away: then every call fails with the host's reason.

const RETRY_MS = 2000;
const HOST_AWAY = 4000; // the relay: no host in the room (relay/worker.js)
const TURNED_AWAY = 4001; // the host, with its reason

/**
 * The doc host reached through the relay the page's `params` name, as
 * `identity()`: { key, made once in this browser; name }.
 */
export function relayHost(params, identity) {
  let url = null;
  let socket = null;
  let online = false; // the host said hello on this line
  let served = false; // and on some line before
  let refused = null; // the host's reason for turning the page away
  let nextCall = 0;
  const calls = new Map(); // sent: id → its resolve
  const unsent = []; // { id, type, arg, done }
  let listener = null;
  const early = [];
  let showLine = () => {};
  let line = null;
  const setLine = (next) => {
    if (next?.reason !== line?.reason) showLine(next);
    line = next;
  };

  function connect() {
    url ??= `${params.get('relay')}/rooms/${params.get('room')}?${new URLSearchParams({ ...(params.get('doc') ? { doc: params.get('doc') } : {}), ...identity() })}`;
    socket = new WebSocket(url);
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.event === 'waiting') return setLine({ reason: 'waiting' });
      if (message.event === 'hello') {
        online = served = true;
        setLine(null);
        for (const request of unsent.splice(0)) send(request);
      }
      if (message.event) return listener ? listener(message.event, message.data) : early.push([message.event, message.data]);
      calls.get(message.id)?.(message.error ? { error: message.error } : { result: message.result });
      calls.delete(message.id);
    });
    // A line not made fires `error` alone in some browsers, `error` and `close` in others.
    let gone = false;
    const lost = ({ code, reason }) => {
      if (gone) return;
      gone = true;
      online = false;
      if (code === TURNED_AWAY) {
        refused = { message: REFUSED[reason] ?? 'The host turned this page away', code: reason };
        for (const done of [...calls.values(), ...unsent.splice(0).map((r) => r.done)]) done({ error: refused });
        calls.clear();
        return setLine({ reason: 'refused', ...refused });
      }
      for (const done of calls.values()) done({ error: { message: 'The host is offline', code: 'offline' } });
      calls.clear();
      setLine({ reason: code === HOST_AWAY ? (served ? 'host' : 'nohost') : 'relay' });
      setTimeout(connect, RETRY_MS);
    };
    socket.addEventListener('error', () => setTimeout(() => lost({}), 100)); // its `close`, if one comes, says more
    socket.addEventListener('close', lost);
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
      else unsent.push(request);
    }),
    onEvent(fn) {
      listener = fn;
      for (const [event, data] of early.splice(0)) fn(event, data);
    },
    /**
     * `fn(line)` hears how the line is: null once the host is in, else
     * `{ reason }`, 'waiting' (for the owner to let the teammate in), 'host'
     * (it went away), 'nohost' (it was never in: the link may be from an
     * earlier time), 'relay' (the relay cannot be reached), or 'refused'
     * with the host's `message` and `code`.
     */
    onLine(fn) {
      showLine = fn;
      if (line) fn(line);
    },
  };
}

// Why the host turns a page away (desktop/doc-host.js), as the page says it.
const REFUSED = {
  not_found: 'This doc is not in the shared project',
  name_taken: 'Someone on this project already has that name',
  bad_input: 'This page could not say who you are',
  denied: 'The owner did not let you in',
  removed: 'The owner removed you from this project',
  link_replaced: 'This link no longer works: ask the owner for the new one',
};
