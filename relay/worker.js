// The relay and the player's page, at one origin (docs/architecture.md,
// Sharing): a Cloudflare Worker that serves the page (dist/web/team.html,
// as static assets; relay/wrangler.toml) and joins the owner's doc host to
// each player's page, with one Durable Object per room. It stores nothing.
//
// Both connect with a WebSocket to /rooms/<room>, the room being the hex
// SHA-256 of a secret only the host knows, the host adding `?host`. No
// credential is in the address: each one's first message says who it is.
// The host's is `{ secret }`, which the relay checks against the room,
// answering `{ hosting: true }`; a page's is any object (its doc, key and
// name), which the host gets when the page joins. The host has one
// connection for every page: the relay numbers each page as a peer, and
// frames go between them as JSON:
//   to the host   { hosting: true }, { peer, open: <the page's first message> }, { peer, data }, { peer, close: true }
//   from the host { peer, data }, { peer, close: <reason> }
// `data` is a page's message as it is, a string. A page is closed with 4000
// while no host is in, or when it goes; with 4001 and the host's reason
// when the host turns it away, or `full` when the room has MAX_PAGES. A host
// whose secret is wrong is closed with 4003. `ping` is answered `pong`
// without waking the room, so a page can tell its line is up.
//
// So that it is no free pipe, and stays within the Workers free plan: a
// message over MAX_MESSAGE closes its sender (1009), an address connects
// at most 60 hosts and 120 pages a minute (the HOSTS and PAGES rate limits
// in wrangler.toml), so a leaked link cannot be hammered, and sockets
// hibernate between messages, so an idle room costs nothing.

/* global WebSocketPair, WebSocketRequestResponsePair */

const ROOM = /^\/rooms\/([0-9a-f]{64})$/;
const MAX_PAGES = 20;
const MAX_MESSAGE = 8 * 2 ** 20; // characters: room for the plain view's longest doc (5,000,000)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.pathname.match(ROOM)?.[1];
    if (!room || request.headers.get('Upgrade') !== 'websocket') return new Response('Not found', { status: 404 });
    const limit = url.searchParams.has('host') ? env.HOSTS : env.PAGES;
    if (!(await limit.limit({ key: request.headers.get('CF-Connecting-IP') ?? '' })).success) return new Response('Too many connections', { status: 429 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

// Each socket's attachment says what it is: { host: false, room } until a
// host's secret is checked, then { host: true }; a page's { peer, open: whether
// its first message reached the host }, or null once the host is told it
// went.
export class Room {
  constructor(ctx) {
    this.ctx = ctx;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const [client, socket] = Object.values(new WebSocketPair());
    if (url.searchParams.has('host')) {
      this.ctx.acceptWebSocket(socket);
      socket.serializeAttachment({ host: false, room: url.pathname.match(ROOM)[1] });
    } else if (!this.#host()) {
      socket.accept();
      socket.close(4000, 'The host is offline'); // so the page knows why
    } else if (this.#pages().length >= MAX_PAGES) {
      socket.accept();
      socket.close(4001, 'full');
    } else {
      this.ctx.acceptWebSocket(socket);
      socket.serializeAttachment({ peer: crypto.getRandomValues(new Uint32Array(1))[0], open: false });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) {
      close(socket, 1009, 'Message too big');
      return this.webSocketClose(socket);
    }
    const what = socket.deserializeAttachment();
    if (what?.host === false) return this.#claim(socket, what.room, data);
    if (what?.host) return this.#fromHost(data);
    if (!what) return;
    const host = this.#host();
    if (what.open) return host?.send(JSON.stringify({ peer: what.peer, data }));
    let open;
    try {
      open = JSON.parse(data);
    } catch {} // not an object: closed below
    if (open === null || typeof open !== 'object') return close(socket, 1008, 'Say who you are first');
    socket.serializeAttachment({ ...what, open: true });
    host?.send(JSON.stringify({ peer: what.peer, open }));
  }

  webSocketClose(socket) {
    const what = socket.deserializeAttachment();
    if (what?.host) {
      if (!this.#host()) this.#hostGone(socket);
    } else if (what && 'peer' in what) {
      socket.serializeAttachment(null); // the host is told once
      if (what.open) this.#host()?.send(JSON.stringify({ peer: what.peer, close: true }));
    }
  }

  webSocketError(socket) {
    this.webSocketClose(socket);
  }

  // A host's first message: the secret of `room`. A host that connects
  // again takes the room over from the one before.
  async #claim(socket, room, data) {
    let secret;
    try {
      ({ secret } = JSON.parse(data));
    } catch {} // checked below
    if (typeof secret !== 'string' || await sha256(secret) !== room) return close(socket, 4003, 'Forbidden');
    for (const host of this.#sockets().filter((s) => s.deserializeAttachment()?.host)) this.#hostGone(host);
    socket.serializeAttachment({ host: true });
    socket.send(JSON.stringify({ hosting: true }));
  }

  #fromHost(data) {
    const { peer, ...frame } = JSON.parse(data);
    const page = this.#pages().find((p) => p.deserializeAttachment()?.peer === peer);
    if (frame.close) {
      page?.serializeAttachment(null);
      close(page, 4001, String(frame.close));
    } else page?.send(frame.data);
  }

  #sockets = () => this.ctx.getWebSockets().filter((s) => s.readyState === WebSocket.OPEN);
  // The host in, if any: one taken over is closing.
  #host = () => this.#sockets().find((s) => s.deserializeAttachment()?.host === true);
  #pages = () => this.#sockets().filter((s) => s.deserializeAttachment()?.peer !== undefined);

  #hostGone(host) {
    close(host, 1000);
    for (const page of this.#pages()) {
      page.serializeAttachment(null);
      close(page, 4000, 'The host is offline');
    }
  }
}

function close(socket, code, reason) {
  try {
    socket?.close(code, reason);
  } catch {} // closed already
}

async function sha256(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
