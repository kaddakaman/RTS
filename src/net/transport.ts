// Connections between devices. Online play uses WebRTC (via PeerJS and its
// free public "matchmaking" server, which only introduces the two devices to
// each other; game data then flows directly between them). A same-browser
// transport (BroadcastChannel) is used for testing two tabs on one computer.

import { Peer, type DataConnection } from 'peerjs';

export interface Link {
  send(m: unknown): void;
  close(): void;
  onmessage: (m: any) => void;
  onclose: () => void;
}

export interface HostTransport {
  code: string;
  onconnect: (link: Link) => void;
  close(): void;
}

const PREFIX = 'shatterfront-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newRoomCode(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export function cleanCode(c: string): string {
  return c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

function wrap(conn: DataConnection): Link {
  const link: Link = {
    send: (m) => {
      if (conn.open) void conn.send(m);
    },
    close: () => conn.close(),
    onmessage: () => {},
    onclose: () => {},
  };
  conn.on('data', (d) => link.onmessage(d));
  conn.on('close', () => link.onclose());
  conn.on('error', () => link.onclose());
  return link;
}

function explain(err: any): string {
  const t = err?.type ?? '';
  if (t === 'peer-unavailable') return 'No game found with that code. Check it and try again.';
  if (t === 'unavailable-id') return 'That room code is taken. Try hosting again.';
  if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed')
    return 'Could not reach the matchmaking server. Check your internet connection.';
  if (t === 'browser-incompatible') return 'This device does not support online play (WebRTC).';
  return err?.message ? String(err.message) : 'Connection failed.';
}

/** Hosts a game that others can join with the returned room code. */
export function hostOnline(code = newRoomCode()): Promise<HostTransport> {
  return new Promise((resolve, reject) => {
    const peer = new Peer(PREFIX + code, { debug: 1 });
    const host: HostTransport = { code, onconnect: () => {}, close: () => peer.destroy() };
    let opened = false;
    const timer = setTimeout(() => {
      if (!opened) {
        peer.destroy();
        reject(new Error('Could not reach the matchmaking server. Check your internet connection.'));
      }
    }, 15000);
    peer.on('open', () => {
      opened = true;
      clearTimeout(timer);
      resolve(host);
    });
    peer.on('connection', (conn) => {
      conn.on('open', () => host.onconnect(wrap(conn)));
    });
    peer.on('error', (err) => {
      if (!opened) {
        clearTimeout(timer);
        peer.destroy();
        reject(new Error(explain(err)));
      }
    });
    peer.on('disconnected', () => {
      // keep existing game connections; just try to stay reachable for new joiners
      if (!peer.destroyed) peer.reconnect();
    });
  });
}

/** Joins a game hosted on another device. */
export function joinOnline(code: string): Promise<Link> {
  return new Promise((resolve, reject) => {
    const peer = new Peer({ debug: 1 });
    let done = false;
    const fail = (msg: string) => {
      if (done) return;
      done = true;
      peer.destroy();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('The host did not answer. Make sure the code is right and the host is still in the lobby.'), 20000);
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + cleanCode(code), { reliable: true, serialization: 'json' });
      conn.on('open', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const link = wrap(conn);
        const close = link.close;
        link.close = () => {
          close();
          peer.destroy();
        };
        resolve(link);
      });
      conn.on('error', (e) => fail(explain(e)));
    });
    peer.on('error', (err) => {
      clearTimeout(timer);
      fail(explain(err));
    });
  });
}

// ---------------------------------------------------------------- same-browser testing

/** Host over a BroadcastChannel (two tabs of the same browser). */
export function hostLocal(code = newRoomCode()): Promise<HostTransport> {
  const ch = new BroadcastChannel('sf-' + code);
  const links = new Map<string, Link>();
  const host: HostTransport = { code, onconnect: () => {}, close: () => ch.close() };
  ch.onmessage = (e) => {
    const { from, to, m, hello, bye } = e.data ?? {};
    if (to !== 'host') return;
    if (hello) {
      const link: Link = {
        send: (msg) => ch.postMessage({ from: 'host', to: from, m: msg }),
        close: () => ch.postMessage({ from: 'host', to: from, bye: true }),
        onmessage: () => {},
        onclose: () => {},
      };
      links.set(from, link);
      host.onconnect(link);
      ch.postMessage({ from: 'host', to: from, ok: true });
      return;
    }
    const link = links.get(from);
    if (!link) return;
    if (bye) link.onclose();
    else link.onmessage(m);
  };
  return Promise.resolve(host);
}

export function joinLocal(code: string): Promise<Link> {
  return new Promise((resolve, reject) => {
    const ch = new BroadcastChannel('sf-' + cleanCode(code));
    const id = Math.random().toString(36).slice(2);
    const link: Link = {
      send: (m) => ch.postMessage({ from: id, to: 'host', m }),
      close: () => {
        ch.postMessage({ from: id, to: 'host', bye: true });
        ch.close();
      },
      onmessage: () => {},
      onclose: () => {},
    };
    const timer = setTimeout(() => reject(new Error('No game found with that code.')), 3000);
    ch.onmessage = (e) => {
      const { to, m, ok, bye } = e.data ?? {};
      if (to !== id) return;
      if (ok) {
        clearTimeout(timer);
        resolve(link);
      } else if (bye) link.onclose();
      else link.onmessage(m);
    };
    ch.postMessage({ from: id, to: 'host', hello: true });
  });
}
