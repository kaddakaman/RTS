// Online play: a host and a guest talk over an in-memory link that
// JSON-encodes every message, just like the real network does.
import { beforeEach, describe, expect, it } from 'vitest';
import { applySnapshot, type LobbyState } from '../src/net/protocol';
import { GuestSession, HostSession } from '../src/net/session';
import type { HostTransport, Link } from '../src/net/transport';
import { applyCommand } from '../src/sim/commands';
import { createMatch } from '../src/sim/match';
import { World, type MatchSetup } from '../src/sim/world';
import { seedRandom } from './helpers';

beforeEach(() => seedRandom(99));

function linkPair(): [Link, Link] {
  const queueA: unknown[] = [];
  const queueB: unknown[] = [];
  const a: Link = { send: (m) => queueB.push(JSON.parse(JSON.stringify(m))), close: () => b.onclose(), onmessage: () => {}, onclose: () => {} };
  const b: Link = { send: (m) => queueA.push(JSON.parse(JSON.stringify(m))), close: () => a.onclose(), onmessage: () => {}, onclose: () => {} };
  const flush = () => {
    let n = 0;
    while ((queueA.length || queueB.length) && n++ < 1000) {
      while (queueA.length) a.onmessage(queueA.shift());
      while (queueB.length) b.onmessage(queueB.shift());
    }
  };
  (a as any).flush = flush;
  return [a, b];
}

const lobby = (): LobbyState => ({
  slots: [
    { kind: 'host', name: 'Host', faction: 'coalition', team: 0, difficulty: 'normal' },
    { kind: 'marauder', name: 'Marauders', faction: 'coalition', team: 1, difficulty: 'normal' },
    { kind: 'open', name: 'Open', faction: 'sythari', team: 1, difficulty: 'normal' },
    { kind: 'marauder', name: 'Marauders', faction: 'coalition', team: 3, difficulty: 'normal' },
  ],
  centerOutpost: true,
});

function connect() {
  const transport: HostTransport = { code: 'TEST1', onconnect: () => {}, close: () => {} };
  const host = new HostSession(transport, lobby());
  const [hostEnd, guestEnd] = linkPair();
  const flush = (hostEnd as any).flush as () => void;
  transport.onconnect(hostEnd);
  const guest = new GuestSession(guestEnd, 'Guest');
  flush();
  return { host, guest, flush };
}

describe('online lobby', () => {
  it('a guest joins the open slot and can pick a faction', () => {
    const { host, guest, flush } = connect();
    expect(guest.slot).toBe(2);
    expect(host.lobby.slots[2].kind).toBe('guest');
    expect(host.lobby.slots[2].name).toBe('Guest');
    guest.pick('coalition');
    flush();
    expect(host.lobby.slots[2].faction).toBe('coalition');
    expect(guest.lobby!.slots[2].faction).toBe('coalition');
  });

  it('a full lobby turns new guests away', () => {
    const { host, flush } = connect();
    const [h2, g2] = linkPair();
    const f2 = (h2 as any).flush as () => void;
    (host.transport.onconnect as (l: Link) => void)(h2);
    let bye = '';
    const g = new GuestSession(g2, 'Late');
    g.onBye = (r) => (bye = r);
    f2();
    flush();
    expect(bye).toMatch(/full/);
  });
});

describe('online match', () => {
  it('the guest sees its own base, sends orders, and the host carries them out', () => {
    const { host, guest, flush } = connect();
    let started: { setup: MatchSetup; slot: number } | null = null;
    guest.onStart = (setup, slot) => (started = { setup, slot });
    const setup: MatchSetup = {
      slots: [
        { kind: 'local', faction: 'coalition', team: 0, name: 'Host' },
        { kind: 'marauder', faction: 'marauder', team: -1, name: 'Marauders' },
        { kind: 'remote', faction: 'sythari', team: 1, name: 'Guest' },
        { kind: 'marauder', faction: 'marauder', team: -1, name: 'Marauders' },
      ],
      centerOutpost: true,
    };
    host.start(setup);
    flush();
    expect(started).not.toBeNull();
    expect(started!.slot).toBe(2);

    const hw = createMatch(setup);
    hw.collectFx = true;
    host.onCommand = (slot, cmd) => applyCommand(hw, slot, cmd);
    const gw = new World({ ...started!.setup, viewer: 2 }, true);
    guest.onSnap = (s) => applySnapshot(gw, s);
    {
      const tick = (seconds: number) => {
        for (let t = 0; t < seconds; t += 1 / 30) {
          hw.update(1 / 30);
          host.bufferFx(hw.fx.splice(0));
          if (Math.round(t * 30) % 3 === 0) host.sendSnapshots(hw);
          flush();
          // the guest works out its own fog of war from what it receives
          gw.updateFog(gw.players[2].team);
        }
      };
      tick(1);
      // the guest's mirror has its own HQ and builder, with the host's ids
      const hq = gw.buildings.find((b) => b.owner === 2 && b.key === 'hq');
      expect(hq).toBeDefined();
      expect(hq!.id).toBe(hw.players[2].hq!.id);
      const builder = gw.units.find((u) => u.owner === 2 && u.key === 'builder')!;
      expect(builder).toBeDefined();
      // ...but not the host's base, which is hidden by fog of war
      expect(gw.buildings.some((b) => b.owner === 0)).toBe(false);
      expect(gw.players[2].supplies).toBe(hw.players[2].supplies);

      // the guest orders a supply depot: find a legal spot using its own mirror
      const pile = gw.nearestPile(hq!.x, hq!.y)!;
      let spot: { x: number; y: number } | null = null;
      for (let dy = -7; dy <= 7 && !spot; dy++)
        for (let dx = -7; dx <= 7 && !spot; dx++) if (gw.canPlace(2, 'depot', pile.tx + dx, pile.ty + dy).ok) spot = { x: pile.tx + dx, y: pile.ty + dy };
      expect(spot).not.toBeNull();
      guest.send({ c: 'construct', key: 'depot', tx: spot!.x, ty: spot!.y, builders: [builder.id] });
      flush();
      expect(hw.buildings.some((b) => b.owner === 2 && b.key === 'depot')).toBe(true);
      tick(35);
      const depot = gw.buildings.find((b) => b.owner === 2 && b.key === 'depot');
      expect(depot?.built).toBe(true);

      // orders for someone else's units are ignored
      const hostBuilder = hw.units.find((u) => u.owner === 0 && u.key === 'builder')!;
      const bx = hostBuilder.x;
      guest.send({ c: 'move', units: [hostBuilder.id], x: 10, y: 10, am: false });
      flush();
      tick(2);
      expect(Math.abs(hostBuilder.x - bx)).toBeLessThan(0.01);
    }
  });
});
