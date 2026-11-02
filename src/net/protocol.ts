// Network messages and world snapshots for online play.
//
// The host runs the real simulation. Ten times a second it sends each guest
// a snapshot of everything that guest's team can see; the guest's copy of the
// world ("mirror") is overwritten from it and drawn with smooth interpolation.
// Guests send their orders to the host as Command objects.

import { FACTIONS, unitDef, type BuildingKey, type FxKind, type ResearchKey, type UnitKey } from '../data/defs';
import type { Command } from '../sim/commands';
import { Building, Pile, Unit, type Alert, type FxEvent, type Projectile } from '../sim/entities';
import { SLOTS, type MatchSetup, type Stats, type World } from '../sim/world';

export const PROTOCOL = 2;

export const UNIT_KEYS: UnitKey[] = ['builder', 'truck', 'rifle', 'sniper', 'rocket', 'scout', 'light', 'tank', 'apc', 'bomber', 'gunship', 'dropship', 'raider', 'rocketeer', 'technical', 'junker'];
export const BUILDING_KEYS: BuildingKey[] = ['hq', 'barracks', 'depot', 'defense', 'factory', 'airbase', 'dropzone', 'super', 'sam', 'arty', 'bunker', 'fortress', 'tower'];
export const RESEARCH_KEYS: ResearchKey[] = ['tier2', 'tier3', 'tier4', 'medic', 'optics', 'speedload', 'aps', 'plating', 'sensors', 'hull', 'jammer', 'cabs', 'rapid'];
export const FX_KINDS: FxKind[] = ['bullet', 'sniper', 'laser', 'rocket', 'plasma', 'shell', 'beam', 'bomb', 'missile', 'arty'];
const FACTION_IDS = ['coalition', 'sythari', 'marauder'] as const;

/** Lobby slot as seen over the network. */
export interface LobbySlot {
  kind: 'host' | 'guest' | 'open' | 'ai' | 'marauder';
  name: string;
  faction: 'coalition' | 'sythari';
  team: number;
  difficulty: 'easy' | 'normal' | 'hard';
}

export interface LobbyState {
  slots: LobbySlot[];
  centerOutpost: boolean;
}

export type HostMsg =
  | { t: 'welcome'; slot: number; lobby: LobbyState; v: number }
  | { t: 'lobby'; lobby: LobbyState }
  | { t: 'start'; setup: MatchSetup; slot: number }
  | { t: 'snap'; s: Snapshot }
  | { t: 'res'; text: string }
  | { t: 'full' }
  | { t: 'bye'; reason: string };

export type GuestMsg = { t: 'hello'; name: string; v: number } | { t: 'pick'; faction: 'coalition' | 'sythari' } | { t: 'cmd'; cmd: Command } | { t: 'bye' };

export interface Snapshot {
  time: number;
  over: boolean;
  wt: number;
  pl: { s: number; tr: number; rs: number[]; pop: number; d: boolean; st: Stats }[];
  u: number[][];
  b: (number | number[][])[][];
  p: number[][];
  pr: number[][];
  fx: FxEvent[];
  al: Alert[];
  z: boolean[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- host side

/** What a given player's team is allowed to know. */
export function makeSnapshot(w: World, slot: number, fx: FxEvent[], alerts: Alert[]): Snapshot {
  const team = w.players[slot].team;
  const friendly = (o: number) => w.players[o]?.team === team;
  const u: number[][] = [];
  for (const x of w.units) {
    if (x.dead) continue;
    const mine = friendly(x.owner);
    if (!mine && (x.container || !w.visibleTo(x, slot))) continue;
    const flags = (x.moving ? 1 : 0) | (x.medic ? 2 : 0) | (x.fireAnim > 0 ? 4 : 0) | (x.ammo > 0 ? 8 : 0);
    u.push([
      x.id, x.owner, UNIT_KEYS.indexOf(x.key), r2(x.x), r2(x.y), r2(x.angle), r2(x.turret), Math.round(x.hp), Math.round(x.maxHp), x.members, flags,
      Math.round(x.cargo), x.container, Math.round(x.abilityCd * 10) / 10, x.passengers.length, mine ? orderCode(x) : 0,
    ]);
  }
  const b: (number | number[][])[][] = [];
  for (const x of w.buildings) {
    if (x.dead) continue;
    const mine = friendly(x.owner);
    if (!mine && !w.visibleTo(x, slot)) continue;
    b.push([
      x.id, x.owner, BUILDING_KEYS.indexOf(x.key), x.tx, x.ty, Math.round(x.hp), x.built ? 1 : 0, Math.round(x.progress * 1000) / 1000, Math.round(x.charge), Math.round(x.dropT * 10) / 10,
      x.garrison?.id ?? 0, x.rally ? r2(x.rally.x) : -1, x.rally ? r2(x.rally.y) : -1, r2(x.turret), x.fireAnim > 0 ? 1 : 0, x.camp,
      mine ? x.queue.map((q) => [q.kind === 'unit' ? 0 : 1, q.kind === 'unit' ? UNIT_KEYS.indexOf(q.key as UnitKey) : RESEARCH_KEYS.indexOf(q.key as ResearchKey), r2(q.t), q.total, q.cost]) : [],
    ]);
  }
  const pr: number[][] = [];
  for (const p of w.projectiles) {
    if (!w.tileVisible(slot, p.x, p.y)) continue;
    pr.push([FX_KINDS.indexOf(p.fx), r2(p.sx), r2(p.sy), r2(p.tx), r2(p.ty), r2(p.t), r2(p.dur), p.toAir ? 1 : 0, FACTION_IDS.indexOf(p.faction as (typeof FACTION_IDS)[number]), Math.round(p.damage)]);
  }
  return {
    time: r2(w.time),
    over: w.over,
    wt: w.winnerTeam,
    pl: w.players.slice(0, SLOTS).map((p) => ({ s: Math.floor(p.supplies), tr: p.tier, rs: [...p.researched].map((k) => RESEARCH_KEYS.indexOf(k)), pop: p.pop, d: p.defeated, st: p.stats })),
    u,
    b,
    p: w.piles.map((p) => [p.id, Math.round(p.amount)]),
    pr,
    fx: fx.filter((e) => e.k === 'super' || w.tileVisible(slot, e.x, e.y) || ('x2' in e && w.tileVisible(slot, e.x2, e.y2))),
    al: alerts.filter((a) => a.owner === slot),
    z: w.camps.map((c) => c.zone.active),
  };
}

/** Rough order type for guests' UI hints. */
function orderCode(u: Unit): number {
  return ['idle', 'move', 'attack', 'attackGround', 'gather', 'build', 'enter', 'rearm'].indexOf(u.order.type);
}

// ---------------------------------------------------------------- guest side

/** Applies a snapshot to the guest's mirror world. */
export function applySnapshot(w: World, s: Snapshot): void {
  w.time = s.time;
  w.over = s.over;
  w.winnerTeam = s.wt;
  s.pl.forEach((p, i) => {
    const pl = w.players[i];
    if (!pl) return;
    pl.supplies = p.s;
    pl.tier = p.tr;
    pl.researched = new Set(p.rs.map((k) => RESEARCH_KEYS[k]));
    pl.pop = p.pop;
    pl.defeated = p.d;
    pl.stats = p.st;
  });

  // units
  const seen = new Set<number>();
  const byId = w.byId;
  for (const a of s.u) {
    const [id, owner, ki, x, y, ang, tur, hp, maxHp, members, flags, cargo, container, cd, npass] = a;
    seen.add(id);
    let u = byId.get(id) as Unit | undefined;
    if (!u || u.kind !== 'unit') {
      const pl = w.players[owner];
      const key = UNIT_KEYS[ki];
      u = new Unit(id, owner, pl.faction, key, unitDef(pl.faction, key), x, y);
      u.px = u.nx = x;
      u.py = u.ny = y;
      w.units.push(u);
      byId.set(id, u);
    }
    u.px = u.x;
    u.py = u.y;
    u.nx = x;
    u.ny = y;
    u.angle = ang;
    u.turret = tur;
    u.hp = hp;
    u.maxHp = maxHp;
    u.members = members;
    u.moving = !!(flags & 1);
    u.medic = !!(flags & 2);
    if (flags & 4) u.fireAnim = 0.12;
    u.ammo = flags & 8 ? 1 : 0;
    u.cargo = cargo;
    u.container = container;
    u.abilityCd = cd;
    u.dead = false;
    // passengers: only the count matters for drawing
    if (u.passengers.length !== npass) u.passengers = new Array(npass).fill(u);
    const oc = a[15];
    const ot = ['idle', 'move', 'attack', 'attackGround', 'gather', 'build', 'enter', 'rearm'][oc] ?? 'idle';
    if (u.order.type !== ot) u.order = ot === 'idle' ? { type: 'idle' } : ({ type: ot } as Unit['order']);
  }
  for (const u of w.units) if (!seen.has(u.id)) u.dead = true;
  w.units = w.units.filter((u) => {
    if (u.dead) byId.delete(u.id);
    return !u.dead;
  });

  // buildings
  const seenB = new Set<number>();
  for (const a of s.b) {
    const [id, owner, ki, tx, ty, hp, built, prog, charge, dropT, garrison, rx, ry, tur, fire, camp, queue] = a as number[] & { 16: number[][] };
    seenB.add(id);
    let b = byId.get(id) as Building | undefined;
    if (!b || b.kind !== 'building') {
      const pl = w.players[owner];
      const key = BUILDING_KEYS[ki];
      b = new Building(id, owner, pl.faction, key, FACTIONS[pl.faction].buildings[key]!, tx, ty);
      w.buildings.push(b);
      byId.set(id, b);
      w.map.setOcc(tx, ty, b.w, b.h, id);
    }
    b.hp = hp;
    b.built = !!built;
    b.progress = prog;
    b.charge = charge;
    b.dropT = dropT;
    b.rally = rx >= 0 ? { x: rx, y: ry } : null;
    b.turret = tur;
    if (fire) b.fireAnim = 0.12;
    b.camp = camp;
    const g = garrison ? (byId.get(garrison) as Unit | undefined) : undefined;
    b.garrison = g && g.kind === 'unit' ? g : null;
    b.queue = (queue as unknown as number[][]).map(([k, key, t, total, cost]) => ({
      kind: k === 0 ? 'unit' : 'research',
      key: k === 0 ? UNIT_KEYS[key] : RESEARCH_KEYS[key],
      t,
      total,
      cost,
    }));
    b.dead = false;
  }
  for (const b of w.buildings) if (!seenB.has(b.id)) {
    b.dead = true;
    w.map.clearOcc(b.tx, b.ty, b.w, b.h, b.id);
    byId.delete(b.id);
  }
  w.buildings = w.buildings.filter((b) => !b.dead);
  for (const pl of w.players) if (pl.hq && pl.hq.dead) pl.hq = null;
  for (const b of w.buildings) if (b.key === 'hq' && !w.players[b.owner].hq) w.players[b.owner].hq = b;

  // supply caches
  for (const [id, amount] of s.p) {
    const p = byId.get(id) as Pile | undefined;
    if (!p || p.kind !== 'pile') continue;
    if (p.amount > 0 && amount <= 0) w.map.clearOcc(p.tx, p.ty, 2, 2, p.id);
    p.amount = amount;
  }

  // projectiles (purely visual on the guest)
  w.projectiles = s.pr.map(
    ([fx, sx, sy, tx, ty, t, dur, air, f, dmg]): Projectile => ({
      fx: FX_KINDS[fx], x: sx, y: sy, sx, sy, tx, ty, target: 0, speed: 0, damage: dmg, dmg: 'small', splash: 0, owner: -1, src: 0, t, dur, toAir: !!air,
      faction: FACTION_IDS[f] ?? 'coalition',
    }),
  );
  w.fx.push(...s.fx);
  for (const a of s.al) {
    a.seq = ++w.alertSeq;
    w.alerts.push(a);
  }
  if (w.alerts.length > 60) w.alerts.splice(0, w.alerts.length - 60);
  s.z.forEach((active, i) => {
    if (w.camps[i]) w.camps[i].zone.active = active;
  });
}

/** Moves guest-side units smoothly between snapshots. */
export function interpolate(w: World, k: number, dt: number): void {
  const t = Math.min(1.15, k);
  for (const u of w.units) {
    u.x = u.px + (u.nx - u.px) * t;
    u.y = u.py + (u.ny - u.py) * t;
    u.fireAnim = Math.max(0, u.fireAnim - dt);
  }
  for (const b of w.buildings) b.fireAnim = Math.max(0, b.fireAnim - dt);
  for (const p of w.projectiles) {
    p.t += dt;
    const kk = Math.min(1, p.t / p.dur);
    p.x = p.sx + (p.tx - p.sx) * kk;
    p.y = p.sy + (p.ty - p.sy) * kk;
  }
}
