// Lobby and in-game networking for the host and for guests.

import type { Command } from '../sim/commands';
import type { Alert, FxEvent } from '../sim/entities';
import type { MatchSetup, World } from '../sim/world';
import { PROTOCOL, makeSnapshot, type GuestMsg, type HostMsg, type LobbyState, type Snapshot } from './protocol';
import type { HostTransport, Link } from './transport';

export class HostSession {
  readonly links = new Map<number, Link>();
  lobby: LobbyState;
  inGame = false;
  onLobby: () => void = () => {};
  onGuestLeft: (slot: number, name: string) => void = () => {};
  onCommand: (slot: number, cmd: Command) => string = () => '';
  private fxBuf = new Map<number, FxEvent[]>();
  private alertSeq = new Map<number, number>();

  constructor(
    readonly transport: HostTransport,
    lobby: LobbyState,
  ) {
    this.lobby = lobby;
    transport.onconnect = (link) => this.accept(link);
  }

  get code(): string {
    return this.transport.code;
  }

  private accept(link: Link): void {
    let slot = -1;
    link.onmessage = (raw) => {
      const m = raw as GuestMsg;
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello') {
        if (this.inGame) {
          link.send({ t: 'full' } satisfies HostMsg);
          link.close();
          return;
        }
        slot = this.lobby.slots.findIndex((s) => s.kind === 'open');
        if (slot < 0) {
          link.send({ t: 'full' } satisfies HostMsg);
          link.close();
          return;
        }
        const s = this.lobby.slots[slot];
        s.kind = 'guest';
        s.name = String(m.name || 'Guest').slice(0, 16);
        this.links.set(slot, link);
        link.send({ t: 'welcome', slot, lobby: this.lobby, v: PROTOCOL } satisfies HostMsg);
        this.broadcastLobby();
        this.onLobby();
      } else if (m.t === 'pick' && slot >= 0 && !this.inGame) {
        if (m.faction === 'coalition' || m.faction === 'sythari') this.lobby.slots[slot].faction = m.faction;
        this.broadcastLobby();
        this.onLobby();
      } else if (m.t === 'cmd' && slot >= 0 && this.inGame) {
        const res = this.onCommand(slot, m.cmd);
        if (res && !['move', 'attack', 'gather', 'build', 'repair', 'garrison', 'board', 'return', 'grenade', 'recon', 'boost', 'unload', 'rearm'].includes(res))
          link.send({ t: 'res', text: res } satisfies HostMsg);
      } else if (m.t === 'bye') link.onclose();
    };
    link.onclose = () => {
      if (slot < 0 || this.links.get(slot) !== link) return;
      this.links.delete(slot);
      const name = this.lobby.slots[slot].name;
      if (!this.inGame) {
        this.lobby.slots[slot].kind = 'open';
        this.lobby.slots[slot].name = 'Open';
        this.broadcastLobby();
        this.onLobby();
      }
      this.onGuestLeft(slot, name);
    };
  }

  broadcastLobby(): void {
    for (const l of this.links.values()) l.send({ t: 'lobby', lobby: this.lobby } satisfies HostMsg);
  }

  start(setup: MatchSetup): void {
    this.inGame = true;
    for (const [slot, l] of this.links) l.send({ t: 'start', setup, slot } satisfies HostMsg);
  }

  /** Collect this frame's effects for every guest. */
  bufferFx(fx: FxEvent[]): void {
    if (!fx.length) return;
    for (const slot of this.links.keys()) {
      const b = this.fxBuf.get(slot) ?? [];
      b.push(...fx);
      if (b.length > 400) b.splice(0, b.length - 400);
      this.fxBuf.set(slot, b);
    }
  }

  sendSnapshots(w: World): void {
    for (const [slot, l] of this.links) {
      const last = this.alertSeq.get(slot) ?? 0;
      const alerts: Alert[] = w.alerts.filter((a) => a.seq > last && a.owner === slot);
      if (w.alerts.length) this.alertSeq.set(slot, w.alerts[w.alerts.length - 1].seq);
      const s = makeSnapshot(w, slot, this.fxBuf.get(slot) ?? [], alerts);
      this.fxBuf.set(slot, []);
      l.send({ t: 'snap', s } satisfies HostMsg);
    }
  }

  close(reason = 'The host left the game.'): void {
    for (const l of this.links.values()) {
      l.send({ t: 'bye', reason } satisfies HostMsg);
      l.close();
    }
    this.links.clear();
    this.transport.close();
  }
}

export class GuestSession {
  slot = -1;
  lobby: LobbyState | null = null;
  onLobby: () => void = () => {};
  onStart: (setup: MatchSetup, slot: number) => void = () => {};
  onSnap: (s: Snapshot) => void = () => {};
  onRes: (text: string) => void = () => {};
  onBye: (reason: string) => void = () => {};
  private closed = false;

  constructor(
    readonly link: Link,
    name: string,
  ) {
    link.onmessage = (raw) => {
      const m = raw as HostMsg;
      if (!m || typeof m !== 'object') return;
      switch (m.t) {
        case 'welcome':
          if (m.v !== PROTOCOL) {
            this.onBye('The host is running a different version of the game. Both phones need the latest version.');
            this.close();
            return;
          }
          this.slot = m.slot;
          this.lobby = m.lobby;
          this.onLobby();
          break;
        case 'lobby':
          this.lobby = m.lobby;
          this.onLobby();
          break;
        case 'start':
          this.slot = m.slot;
          this.onStart(m.setup, m.slot);
          break;
        case 'snap':
          this.onSnap(m.s);
          break;
        case 'res':
          this.onRes(m.text);
          break;
        case 'full':
          this.onBye('That game is full or has already started.');
          break;
        case 'bye':
          this.onBye(m.reason);
          break;
      }
    };
    link.onclose = () => {
      if (!this.closed) this.onBye('Lost connection to the host.');
      this.closed = true;
    };
    link.send({ t: 'hello', name, v: PROTOCOL } satisfies GuestMsg);
  }

  pick(faction: 'coalition' | 'sythari'): void {
    this.link.send({ t: 'pick', faction } satisfies GuestMsg);
  }

  send(cmd: Command): void {
    this.link.send({ t: 'cmd', cmd } satisfies GuestMsg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.link.send({ t: 'bye' } satisfies GuestMsg);
    this.link.close();
  }
}
