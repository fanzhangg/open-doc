// The relay (docs/architecture.md, Sharing): a Cloudflare Worker with one
// Durable Object per room. It joins the owner's doc host to each teammate's
// page and stores nothing.
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
// when the host turns it away.

/* global WebSocketPair */

const ROOM = /^\/rooms\/([0-9a-f]{64})$/;

export default {
  fetch(request, env) {
    const room = new URL(request.url).pathname.match(ROOM)?.[1];
    if (!room || request.headers.get('Upgrade') !== 'websocket') return new Response('Not found', { status: 404 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

export class Room {
  host = null;
  pages = new Map(); // peer → its socket
  nextPeer = 0;

  async fetch(request) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret');
    if (secret !== null && await sha256(secret) !== url.pathname.match(ROOM)[1]) return new Response('Forbidden', { status: 403 });
    const [client, socket] = Object.values(new WebSocketPair());
    socket.accept();
    if (secret !== null) this.#host(socket);
    else if (!this.host) socket.close(4000, 'The host is offline'); // so the page knows why
    else this.#page(socket, Object.fromEntries(url.searchParams));
    return new Response(null, { status: 101, webSocket: client });
  }

  // A host that connects again takes the room over from the one before.
  #host(socket) {
    this.#hostGone();
    this.host = socket;
    socket.addEventListener('message', ({ data }) => {
      const { peer, ...frame } = JSON.parse(data);
      const page = this.pages.get(peer);
      if (frame.close) {
        this.pages.delete(peer);
        page?.close(4001, String(frame.close));
      } else page?.send(frame.data);
    });
    socket.addEventListener('close', () => {
      if (this.host === socket) this.#hostGone();
    });
  }

  #hostGone() {
    const host = this.host;
    this.host = null;
    try {
      host?.close(1000);
    } catch {} // closed already
    for (const page of this.pages.values()) page.close(4000, 'The host is offline');
    this.pages.clear();
  }

  #page(socket, open) {
    const peer = ++this.nextPeer;
    this.pages.set(peer, socket);
    this.host.send(JSON.stringify({ peer, open }));
    socket.addEventListener('message', ({ data }) => this.host?.send(JSON.stringify({ peer, data })));
    socket.addEventListener('close', () => {
      if (this.pages.delete(peer)) this.host?.send(JSON.stringify({ peer, close: true }));
    });
  }
}

async function sha256(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
