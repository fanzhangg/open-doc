// The relay and the teammate's page, at one origin (docs/architecture.md,
// Sharing): a Cloudflare Worker that serves the page (dist/web/team.html,
// as static assets; relay/wrangler.toml) and joins the owner's doc host to
// each teammate's page, with one Durable Object per room. It stores nothing.
//
// Both connect with a WebSocket to /rooms/<room>, the room being the hex
// SHA-256 of a secret only the host knows: the host adds `?secret=<it>`, a
// page any other parameters, which the host gets when it joins (`?doc=`).
// The host has one connection for every page: the relay numbers each page
// as a peer, and frames go between them as JSON:
//   to the host   { peer, open: { <parameter>: value } }, { peer, data }, { peer, close: true }
//   from the host { peer, data }, { peer, close: <reason> }
// `data` is a page's message as it is, a string. A page is closed with 4000
// while no host is in, or when it goes; with 4001 and the host's reason
// when the host turns it away, or `full` when the room has MAX_PAGES.
//
// So that it is no free pipe, and stays within the Workers free plan: a
// message over MAX_MESSAGE closes its sender (1009), an address opens at
// most HOSTS_PER_MINUTE rooms (the HOSTS rate limit in wrangler.toml), and
// sockets hibernate between messages, so an idle room costs nothing.

/* global WebSocketPair */

const ROOM = /^\/rooms\/([0-9a-f]{64})$/;
const MAX_PAGES = 20;
const MAX_MESSAGE = 8 * 2 ** 20; // characters: room for the plain view's longest doc (5,000,000)

export default {
  async fetch(request, env) {
    const room = new URL(request.url).pathname.match(ROOM)?.[1];
    if (!room || request.headers.get('Upgrade') !== 'websocket') return new Response('Not found', { status: 404 });
    const hosting = new URL(request.url).searchParams.has('secret');
    if (hosting && !(await env.HOSTS.limit({ key: request.headers.get('CF-Connecting-IP') ?? '' })).success) {
      return new Response('Too many rooms', { status: 429 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

// Sockets are tagged `host` or `page`; a page's attachment is its peer.
export class Room {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret');
    if (secret !== null && await sha256(secret) !== url.pathname.match(ROOM)[1]) return new Response('Forbidden', { status: 403 });
    const [client, socket] = Object.values(new WebSocketPair());
    if (secret !== null) {
      // A host that connects again takes the room over from the one before.
      for (const host of this.ctx.getWebSockets('host')) this.#hostGone(host);
      this.ctx.acceptWebSocket(socket, ['host']);
    } else if (!this.#host()) {
      socket.accept();
      socket.close(4000, 'The host is offline'); // so the page knows why
    } else if (this.#pages().length >= MAX_PAGES) {
      socket.accept();
      socket.close(4001, 'full');
    } else {
      const peer = crypto.getRandomValues(new Uint32Array(1))[0];
      this.ctx.acceptWebSocket(socket, ['page']);
      socket.serializeAttachment(peer);
      this.#host().send(JSON.stringify({ peer, open: Object.fromEntries(url.searchParams) }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) {
      close(socket, 1009, 'Message too big');
      return this.webSocketClose(socket);
    }
    if (!this.#isHost(socket)) return this.#host()?.send(JSON.stringify({ peer: socket.deserializeAttachment(), data }));
    const { peer, ...frame } = JSON.parse(data);
    const page = this.#pages().find((p) => p.deserializeAttachment() === peer);
    if (frame.close) {
      page?.serializeAttachment(null);
      close(page, 4001, String(frame.close));
    }
    else page?.send(frame.data);
  }

  webSocketClose(socket) {
    if (this.#isHost(socket)) {
      if (!this.#host()) this.#hostGone(socket);
    } else {
      const peer = socket.deserializeAttachment();
      socket.serializeAttachment(null); // the host is told once
      if (peer !== null) this.#host()?.send(JSON.stringify({ peer, close: true }));
    }
  }

  webSocketError(socket) {
    this.webSocketClose(socket);
  }

  // The host in, if any: one taken over is closing.
  #host = () => this.ctx.getWebSockets('host').find((s) => s.readyState === WebSocket.OPEN);
  #pages = () => this.ctx.getWebSockets('page').filter((s) => s.readyState === WebSocket.OPEN);
  #isHost = (socket) => this.ctx.getTags(socket).includes('host');

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
