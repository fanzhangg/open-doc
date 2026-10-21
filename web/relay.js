// The page's line to the doc host in a plain browser: through the relay
// (relay/worker.js; docs/architecture.md, Sharing), with the same
// `{ call, onEvent }` the app's preload gives a window (window.opendocHost).
// The page's address names the relay, the room and the doc:
// `?relay=<ws: or wss: URL>&room=<room>&doc=<path in the project>`.
// While the host is away, a call waits for it, one that was on its way
// fails as `offline`, and the page hears `offline`; the line is made again
// every few seconds, and the host's `hello` on it resyncs the page.

const RETRY_MS = 2000;

/** The doc host reached through the relay the page's `params` name. */
export function relayHost(params) {
  const url = `${params.get('relay')}/rooms/${params.get('room')}?doc=${encodeURIComponent(params.get('doc') ?? '')}`;
  let socket = null;
  let online = false;
  let nextCall = 0;
  const calls = new Map(); // sent: id → its resolve
  const unsent = []; // { id, type, arg, done }
  let listener = null;
  const early = [];
  const tell = (event, data) => (listener ? listener(event, data) : early.push([event, data]));

  function connect() {
    socket = new WebSocket(url);
    socket.addEventListener('open', () => {
      online = true;
      for (const request of unsent.splice(0)) send(request);
    });
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.event) return tell(message.event, message.data);
      calls.get(message.id)?.(message.error ? { error: message.error } : { result: message.result });
      calls.delete(message.id);
    });
    // A line refused fires `error` alone in some browsers, `error` and `close` in others.
    let gone = false;
    const lost = () => {
      if (gone) return;
      gone = true;
      for (const done of calls.values()) done({ error: { message: 'The host is offline', code: 'offline' } });
      calls.clear();
      if (online) tell('offline', {});
      online = false;
      setTimeout(connect, RETRY_MS);
    };
    socket.addEventListener('error', lost);
    socket.addEventListener('close', lost);
  }
  function send({ done, ...request }) {
    calls.set(request.id, done);
    socket.send(JSON.stringify(request));
  }
  connect();

  return {
    call: (type, arg) => new Promise((done) => {
      const request = { id: ++nextCall, type: String(type), arg, done };
      if (online) send(request);
      else unsent.push(request);
    }),
    onEvent(fn) {
      listener = fn;
      for (const [event, data] of early.splice(0)) fn(event, data);
    },
  };
}
