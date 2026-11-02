// The simulation: economy, production, construction, movement, combat,
// fog of war and victory. It has no rendering and runs the same in tests.

import { clamp, dist, distToRect, turnTowards, wrapAngle } from '../core/math';
import {
  ABILITIES,
  BOOST,
  FACTIONS,
  FORTRESS_BOUNTY,
  GRENADE,
  POP_CAP,
  RECON,
  STARTING_SUPPLIES,
  UPGRADE,
  buildingDef,
  damageMult,
  researchDef,
  unitDef,
  weaponCanHit,
  type Armor,
  type BuildingKey,
  type DmgType,
  type FactionId,
  type ResearchKey,
  type UnitKey,
  type WeaponDef,
} from '../data/defs';
import { Building, Pile, Unit, type Alert, type Entity, type FxEvent, type Projectile, type Thing } from './entities';
import { GameMap, castVision, generateMap, type CampSpot, type Zone } from './map';
import { PathCache } from './paths';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface Ghost {
  id: number;
  key: BuildingKey;
  faction: FactionId;
  owner: number;
  tx: number;
  ty: number;
  w: number;
  h: number;
  built: boolean;
  hpFrac: number;
}

export interface Stats {
  unitsBuilt: number;
  unitsLost: number;
  kills: number;
  structuresBuilt: number;
  structuresLost: number;
  structuresDestroyed: number;
  gathered: number;
  spent: number;
}

/** What a team can see: shared by all players on the team. */
export class Vision {
  vis: Uint8Array;
  explored: Uint8Array;
  ghosts = new Map<number, Ghost>();
  constructor(size: number) {
    this.vis = new Uint8Array(size);
    this.explored = new Uint8Array(size);
  }
}

export type SlotKind = 'local' | 'remote' | 'ai' | 'marauder';

export interface SlotSetup {
  kind: SlotKind;
  faction: FactionId;
  team: number;
  name: string;
  difficulty?: Difficulty;
}

export class Player {
  supplies = STARTING_SUPPLIES;
  tier = 1;
  researched = new Set<ResearchKey>();
  defeated = false;
  /** Gathering multiplier (AI difficulty handicap / bonus). */
  gatherMul = 1;
  pop = 0;
  recon: { x: number; y: number; until: number }[] = [];
  alertT = new Map<string, number>();
  stats: Stats = { unitsBuilt: 0, unitsLost: 0, kills: 0, structuresBuilt: 0, structuresLost: 0, structuresDestroyed: 0, gathered: 0, spent: 0 };
  /** Rolling income tracker (supplies per minute). */
  incomeLog: { t: number; amt: number }[] = [];
  hq: Building | null = null;
  vision!: Vision;

  constructor(
    readonly id: number,
    readonly faction: FactionId,
    public name: string,
    readonly team: number,
    readonly kind: SlotKind | 'neutral',
  ) {}

  /** A real side in this match (not an empty base or the Marauders). */
  get active(): boolean {
    return this.kind === 'local' || this.kind === 'remote' || this.kind === 'ai';
  }

  get isAI(): boolean {
    return this.kind === 'ai';
  }

  get vis(): Uint8Array {
    return this.vision.vis;
  }

  get explored(): Uint8Array {
    return this.vision.explored;
  }

  get ghosts(): Map<number, Ghost> {
    return this.vision.ghosts;
  }

  get popCap(): number {
    return POP_CAP[this.tier] ?? 100;
  }
}

export interface MatchSetup {
  /** Four base slots. Unused bases are taken over by the Marauders. */
  slots: SlotSetup[];
  /** Marauder outpost guarding the central hoard. */
  centerOutpost: boolean;
  /** Reveal the whole map (debug / spectating). */
  reveal?: boolean;
  /** Which slot this device controls (for fog of war and alerts). */
  viewer?: number;
}

export interface Controller {
  update(dt: number): void;
}

export interface NeutralHook {
  provoke(player: number, camp: number, amount: number, x: number, y: number): void;
  onFortressDestroyed(camp: number): void;
}

/** A Marauder camp: an empty base slot taken over, or the central outpost (index 4). */
export interface Camp {
  index: number;
  spot: CampSpot;
  zone: Zone;
  pileIds: number[];
}

interface Strike {
  x: number;
  y: number;
  t: number;
  owner: number;
  faction: FactionId;
  radius: number;
  damage: number;
}

const CELL = 4;
export const SLOTS = 4;
export const NEUTRAL = 4;
export const CENTER_CAMP = 4;
const SAFE_DIST = 0.85;

export class World {
  readonly map: GameMap;
  readonly paths: PathCache;
  readonly players: Player[];
  units: Unit[] = [];
  buildings: Building[] = [];
  piles: Pile[] = [];
  projectiles: Projectile[] = [];
  fx: FxEvent[] = [];
  alerts: Alert[] = [];
  alertSeq = 0;
  strikes: Strike[] = [];
  readonly byId = new Map<number, Thing>();
  private nextId = 1;
  time = 0;
  winner = -1;
  over = false;
  controllers: Controller[] = [];
  neutralHook: NeutralHook | null = null;
  readonly gw: number;
  readonly gh: number;
  private cells: Unit[][];
  private fogT = new Map<number, number>();
  camps: Camp[] = [];
  /** Team that won (-1 = none yet / draw). */
  winnerTeam = -1;
  viewer = 0;
  reveal = false;
  /** Disable visual event collection (headless tests). */
  collectFx = true;

  constructor(
    readonly setup: MatchSetup,
    mirror = false,
  ) {
    this.map = generateMap();
    this.paths = new PathCache(this.map);
    const size = this.map.w * this.map.h;
    this.players = setup.slots.map((sl, i) => new Player(i, sl.kind === 'marauder' ? 'marauder' : sl.faction, sl.name, sl.kind === 'marauder' ? -1 - i : sl.team, sl.kind));
    this.players.push(new Player(NEUTRAL, 'marauder', 'Marauders', -100, 'neutral'));
    const visions = new Map<number, Vision>();
    for (const p of this.players) {
      let v = visions.get(p.team);
      if (!v) {
        v = new Vision(size);
        // the terrain is always known; fog of war only hides units and structures
        v.explored.fill(1);
        visions.set(p.team, v);
      }
      p.vision = v;
    }
    this.reveal = !!setup.reveal;
    this.viewer = setup.viewer ?? 0;
    this.gw = Math.ceil(this.map.w / CELL);
    this.gh = Math.ceil(this.map.h / CELL);
    this.cells = Array.from({ length: this.gw * this.gh }, () => []);
    if (!mirror) this.setupMatch();
    else this.setupMirror();
  }

  /** Online guests: same map, caches and territories, but entities arrive from the host. */
  private setupMirror(): void {
    const m = this.map;
    for (const p of m.piles) {
      const pile = new Pile(this.nextId++, p.x, p.y, p.amount, p.label);
      this.piles.push(pile);
      this.byId.set(pile.id, pile);
      m.setOcc(p.x, p.y, 2, 2, pile.id);
    }
    for (let i = 0; i < SLOTS; i++) if (!this.players[i].active) this.camps.push(this.makeCamp(i, m.starts[i].camp));
    if (this.setup.centerOutpost) this.camps.push(this.makeCamp(CENTER_CAMP, m.center));
    m.zones = this.camps.map((c) => c.zone);
  }

  private makeCamp(index: number, spot: CampSpot): Camp {
    const zone: Zone = { cx: spot.cx, cy: spot.cy, r: spot.r, active: true };
    return { index, spot, zone, pileIds: this.piles.filter((p) => Math.hypot(p.x - spot.cx, p.y - spot.cy) < spot.r).map((p) => p.id) };
  }

  /** Can a and b fight each other? */
  hostile(a: number, b: number): boolean {
    if (a === b) return false;
    return this.players[a].team !== this.players[b].team;
  }

  /** Real players still in the game. */
  get activePlayers(): Player[] {
    return this.players.filter((p) => p.active);
  }

  // ---------------------------------------------------------------- setup

  private setupMatch(): void {
    const m = this.map;
    for (const p of m.piles) {
      const pile = new Pile(this.nextId++, p.x, p.y, p.amount, p.label);
      this.piles.push(pile);
      this.byId.set(pile.id, pile);
      m.setOcc(p.x, p.y, 2, 2, pile.id);
    }
    for (let i = 0; i < SLOTS; i++) {
      const s = m.starts[i];
      const pl = this.players[i];
      if (!pl.active) {
        this.addCamp(i, s.camp);
        continue;
      }
      const hq = this.addBuilding(i, 'hq', s.hq.x, s.hq.y, true);
      pl.hq = hq;
      // first units roll out towards the main ramp
      const ramp = s.ramps[0];
      const a = Math.atan2(ramp.y - hq.y, ramp.x - hq.x);
      const builder = this.spawnUnit(i, 'builder', hq.x + Math.cos(a) * 3.2, hq.y + Math.sin(a) * 3.2);
      builder.angle = a;
      const main = this.nearestPile(hq.x, hq.y);
      const truck = this.spawnUnit(i, 'truck', main ? (hq.x + main.x) / 2 : hq.x, main ? (hq.y + main.y) / 2 : hq.y + 3);
      if (main) this.cmdGather([truck], main);
    }
    if (this.setup.centerOutpost) this.addCamp(CENTER_CAMP, m.center);
    m.zones = this.camps.map((c) => c.zone);
    for (const p of this.players) this.updateFog(p.team);
  }

  private addCamp(index: number, spot: CampSpot): void {
    this.camps.push(this.makeCamp(index, spot));
    const f = this.addBuilding(NEUTRAL, 'fortress', spot.fortress.x, spot.fortress.y, true);
    f.camp = index;
    for (const t of spot.towers) this.addBuilding(NEUTRAL, 'tower', t.x, t.y, true).camp = index;
    for (const p of spot.posts) {
      const u = this.spawnUnit(NEUTRAL, p.key, p.x, p.y);
      u.territorial = true;
      u.camp = index;
    }
  }

  camp(index: number): Camp | undefined {
    return this.camps.find((c) => c.index === index);
  }

  // ---------------------------------------------------------------- lookup helpers

  get(id: number): Thing | undefined {
    return this.byId.get(id);
  }

  entity(id: number): Entity | undefined {
    const e = this.byId.get(id);
    if (!e || e.kind === 'pile') return undefined;
    return e;
  }

  unitsOf(owner: number): Unit[] {
    return this.units.filter((u) => u.owner === owner && !u.dead);
  }

  buildingsOf(owner: number): Building[] {
    return this.buildings.filter((b) => b.owner === owner && !b.dead);
  }

  hasBuilt(owner: number, key: BuildingKey): boolean {
    return this.buildings.some((b) => b.owner === owner && b.key === key && b.built && !b.dead);
  }

  countBuildings(owner: number, key: BuildingKey): number {
    return this.buildings.filter((b) => b.owner === owner && b.key === key && !b.dead).length;
  }

  nearestPile(x: number, y: number, filter?: (p: Pile) => boolean): Pile | null {
    let best: Pile | null = null;
    let bd = Infinity;
    for (const p of this.piles) {
      if (p.amount <= 0 || (filter && !filter(p))) continue;
      const d = dist(x, y, p.x, p.y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  /** Inside any active Marauder territory? */
  inZone(x: number, y: number, pad = 0): boolean {
    for (const c of this.camps) if (c.zone.active && dist(x, y, c.zone.cx, c.zone.cy) <= c.zone.r + pad) return true;
    return false;
  }

  /** Inside a specific camp's territory? */
  inCamp(index: number, x: number, y: number, pad = 0): boolean {
    const c = this.camp(index);
    return !!c && c.zone.active && dist(x, y, c.zone.cx, c.zone.cy) <= c.zone.r + pad;
  }

  /** Distance from a point to the nearest edge of a thing. */
  edgeDist(x: number, y: number, e: Thing): number {
    if (e.kind === 'unit') return Math.max(0, dist(x, y, e.x, e.y) - e.radius * 0.6);
    return distToRect(x, y, e.tx, e.ty, e.w, e.h);
  }

  visibleTo(e: Thing, p: number): boolean {
    if (this.reveal && p === this.viewer) return true;
    const vis = this.players[p].vis;
    const W = this.map.w;
    if (e.kind === 'unit') {
      const tx = Math.floor(e.x);
      const ty = Math.floor(e.y);
      if (tx < 0 || ty < 0 || tx >= W || ty >= this.map.h) return false;
      return vis[ty * W + tx] === 1;
    }
    for (let y = e.ty; y < e.ty + e.h; y++) for (let x = e.tx; x < e.tx + e.w; x++) if (vis[y * W + x] === 1) return true;
    return false;
  }

  tileVisible(p: number, x: number, y: number): boolean {
    if (this.reveal && p === this.viewer) return true;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!this.map.inBounds(tx, ty)) return false;
    return this.players[p].vis[ty * this.map.w + tx] === 1;
  }

  tileExplored(p: number, x: number, y: number): boolean {
    if (this.reveal && p === this.viewer) return true;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!this.map.inBounds(tx, ty)) return false;
    return this.players[p].explored[ty * this.map.w + tx] === 1;
  }

  // ---------------------------------------------------------------- spatial grid

  private rebuildGrid(): void {
    for (const c of this.cells) c.length = 0;
    for (const u of this.units) {
      if (u.dead || u.container) continue;
      const cx = clamp(Math.floor(u.x / CELL), 0, this.gw - 1);
      const cy = clamp(Math.floor(u.y / CELL), 0, this.gh - 1);
      this.cells[cy * this.gw + cx].push(u);
    }
  }

  /** Calls fn for every (outside, alive) unit within r of (x, y). */
  forUnitsNear(x: number, y: number, r: number, fn: (u: Unit, d: number) => void): void {
    const x0 = clamp(Math.floor((x - r) / CELL), 0, this.gw - 1);
    const x1 = clamp(Math.floor((x + r) / CELL), 0, this.gw - 1);
    const y0 = clamp(Math.floor((y - r) / CELL), 0, this.gh - 1);
    const y1 = clamp(Math.floor((y + r) / CELL), 0, this.gh - 1);
    const r2 = r * r;
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++)
        for (const u of this.cells[cy * this.gw + cx]) {
          if (u.dead || u.container) continue;
          const dx = u.x - x;
          const dy = u.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= r2) fn(u, Math.sqrt(d2));
        }
  }

  // ---------------------------------------------------------------- creation

  spawnUnit(owner: number, key: UnitKey, x: number, y: number): Unit {
    const faction = this.players[owner].faction;
    const def = unitDef(faction, key);
    let px = x;
    let py = y;
    if (def.move !== 'air') {
      const p = this.map.nearestPassable(x, y, def.move);
      if (p) {
        px = p.x;
        py = p.y;
      }
    }
    const u = new Unit(this.nextId++, owner, faction, key, def, px, py);
    this.applyUpgrades(u);
    this.units.push(u);
    this.byId.set(u.id, u);
    return u;
  }

  /** Has this player researched an upgrade? */
  has(owner: number, key: ResearchKey): boolean {
    return this.players[owner]?.researched.has(key) ?? false;
  }

  /** Vision range, including upgrades (and a sniper team that lost its spotter). */
  sightOf(u: Unit): number {
    let s = u.def.sight;
    if (u.key === 'sniper') {
      if (this.has(u.owner, 'optics')) s += UPGRADE.optics.sight;
      if (u.alive < 2) s -= 3;
    }
    if (u.key === 'scout' && this.has(u.owner, 'sensors')) s += UPGRADE.sensors.sight;
    return s;
  }

  rangeBonus(u: Unit): number {
    return u.key === 'sniper' && this.has(u.owner, 'optics') ? UPGRADE.optics.range : 0;
  }

  capacityOf(u: Unit): number {
    return (u.def.capacity ?? 0) + (u.key === 'apc' && this.has(u.owner, 'hull') ? UPGRADE.hull.capacity : 0);
  }

  /** Applies any researched health upgrades (and medics) a unit doesn't have yet. */
  private applyUpgrades(u: Unit): void {
    const hp: [ResearchKey, UnitKey, number][] = [
      ['plating', 'light', UPGRADE.plating.hp],
      ['hull', 'apc', UPGRADE.hull.hp],
      ['cabs', 'truck', UPGRADE.cabs.hp],
    ];
    for (const [k, key, m] of hp) {
      if (u.key !== key || !this.has(u.owner, k) || u.upgrades.has(k)) continue;
      u.upgrades.add(k);
      u.maxHp *= m;
      u.hp *= m;
    }
    if (u.def.medic && this.has(u.owner, 'medic')) this.addMedic(u);
  }

  private addMedic(u: Unit): void {
    if (u.medic) return;
    u.medic = true;
    u.members += 1;
    u.maxHp += u.memberHp;
    u.hp += u.memberHp;
  }

  addBuilding(owner: number, key: BuildingKey, tx: number, ty: number, built: boolean): Building {
    const faction = this.players[owner].faction;
    const def = buildingDef(faction, key);
    const b = new Building(this.nextId++, owner, faction, key, def, tx, ty);
    b.built = built;
    b.progress = built ? 1 : 0;
    if (!built) b.hp = Math.max(1, b.maxHp * 0.08);
    this.buildings.push(b);
    this.byId.set(b.id, b);
    this.map.setOcc(tx, ty, def.w, def.h, b.id);
    // shove units out of the footprint
    for (const u of this.units) {
      if (u.dead || u.container || u.air) continue;
      if (u.x >= tx - 0.2 && u.x <= tx + def.w + 0.2 && u.y >= ty - 0.2 && u.y <= ty + def.h + 0.2) {
        const p = this.map.nearestPassable(u.x, u.y, u.def.move);
        if (p) {
          u.x = p.x;
          u.y = p.y;
        }
      }
    }
    return b;
  }

  // ---------------------------------------------------------------- placement rules

  canPlace(owner: number, key: BuildingKey, tx: number, ty: number): { ok: boolean; reason: string } {
    const pl = this.players[owner];
    const fac = FACTIONS[pl.faction];
    const def = fac.buildings[key];
    if (!def) return { ok: false, reason: 'Unknown building' };
    const req = this.requirement(owner, key);
    if (req) return { ok: false, reason: req };
    if (pl.supplies < def.cost) return { ok: false, reason: 'Not enough supplies' };
    for (let y = ty; y < ty + def.h; y++)
      for (let x = tx; x < tx + def.w; x++) {
        if (!this.map.buildable(x, y)) return { ok: false, reason: 'Needs clear, flat ground' };
        if (!this.tileExplored(owner, x + 0.5, y + 0.5)) return { ok: false, reason: 'Area not explored' };
      }
    const cx = tx + def.w / 2;
    const cy = ty + def.h / 2;
    if (this.inZone(cx, cy, 0.5)) return { ok: false, reason: 'Inside Marauder territory' };
    // keep a walkable gap around the HQ and production buildings
    for (const b of this.buildings) {
      if (b.dead) continue;
      const gap = b.tx - (tx + def.w) >= 1 || tx - (b.tx + b.w) >= 1 || b.ty - (ty + def.h) >= 1 || ty - (b.ty + b.h) >= 1;
      if (!gap) return { ok: false, reason: 'Too close to another building' };
    }
    for (const p of this.piles) {
      const gap = p.tx - (tx + def.w) >= 1 || tx - (p.tx + 2) >= 1 || p.ty - (ty + def.h) >= 1 || ty - (p.ty + 2) >= 1;
      if (!gap) return { ok: false, reason: 'Too close to a supply cache' };
    }
    // don't let anyone wall off a ramp
    for (const s of this.map.starts) for (const r of s.ramps) if (distToRect(r.x, r.y, tx, ty, def.w, def.h) < 3) return { ok: false, reason: 'Would block a ramp' };
    if (def.nearPile) {
      const near = this.piles.some((p) => p.amount > 0 && distToRect(p.x, p.y, tx, ty, def.w, def.h) <= def.nearPile!);
      if (!near) return { ok: false, reason: 'Must be near a supply cache' };
    }
    return { ok: true, reason: '' };
  }

  /** Why a building can't be built yet (tech requirements), or '' if it can. */
  requirement(owner: number, key: BuildingKey): string {
    const pl = this.players[owner];
    const fac = FACTIONS[pl.faction];
    const def = fac.buildings[key];
    if (!def) return 'Unavailable';
    if (def.tier && pl.tier < def.tier) return `Requires HQ Tier ${def.tier}`;
    for (const n of def.needs ?? []) {
      if (!this.hasBuilt(owner, n)) return `Requires ${fac.buildings[n]?.name ?? n}`;
    }
    if (def.max && this.countBuildings(owner, key) >= def.max) return `Limit of ${def.max} reached`;
    return '';
  }

  // ---------------------------------------------------------------- commands

  /** Arranges units in a loose formation around a point. */
  private formationSlots(x: number, y: number, units: Unit[]): Map<Unit, { x: number; y: number }> {
    const out = new Map<Unit, { x: number; y: number }>();
    if (units.length === 1) {
      const u = units[0];
      const p = u.air ? { x, y } : this.map.nearestPassable(x, y, u.def.move) ?? { x, y };
      out.set(u, p);
      return out;
    }
    const maxR = Math.max(...units.map((u) => u.radius));
    const spacing = maxR * 2 + 0.25;
    const slots: { x: number; y: number; d: number }[] = [];
    slots.push({ x, y, d: 0 });
    for (let ring = 1; slots.length < units.length * 3 + 6 && ring < 12; ring++) {
      const n = ring * 6;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + ring * 0.3;
        slots.push({ x: x + Math.cos(a) * ring * spacing, y: y + Math.sin(a) * ring * spacing, d: ring });
      }
    }
    const used = new Set<number>();
    const sorted = [...units].sort((a, b) => dist(a.x, a.y, x, y) - dist(b.x, b.y, x, y));
    for (const u of sorted) {
      let bi = -1;
      let bs = Infinity;
      for (let i = 0; i < slots.length; i++) {
        if (used.has(i)) continue;
        const s = slots[i];
        if (!u.air && (!this.map.passableXY(s.x, s.y, u.def.move) || !this.map.passableXY(s.x + 0.3, s.y + 0.3, u.def.move) || !this.map.passableXY(s.x - 0.3, s.y - 0.3, u.def.move)))
          continue;
        if (s.x < 0.5 || s.y < 0.5 || s.x > this.map.w - 0.5 || s.y > this.map.h - 0.5) continue;
        const score = s.d * 4 + dist(u.x, u.y, s.x, s.y) * 0.05;
        if (score < bs) {
          bs = score;
          bi = i;
        }
      }
      if (bi >= 0) {
        used.add(bi);
        out.set(u, { x: slots[bi].x, y: slots[bi].y });
      } else out.set(u, { x, y });
    }
    return out;
  }

  private resetUnitState(u: Unit): void {
    if (u.gState === 'loading' && u.loadingPile) this.releasePile(u);
    u.chase = null;
  }

  cmdMove(units: Unit[], x: number, y: number, attackMove = false): void {
    const list = units.filter((u) => !u.dead && !u.container);
    x = clamp(x, 0.5, this.map.w - 0.5);
    y = clamp(y, 0.5, this.map.h - 0.5);
    const slots = this.formationSlots(x, y, list);
    for (const u of list) {
      this.resetUnitState(u);
      const s = slots.get(u)!;
      u.order = { type: 'move', x: s.x, y: s.y, attackMove, gx: x, gy: y };
      this.setGoal(u, s.x, s.y, 0.3, x, y);
    }
  }

  cmdAttack(units: Unit[], target: Entity): void {
    const movers: Unit[] = [];
    for (const u of units) {
      if (u.dead || u.container) continue;
      this.resetUnitState(u);
      const canHit = u.def.bomber ? target.armor !== 'air' : u.def.weapons.some((w) => weaponCanHit(w, target.armor));
      if (canHit) {
        u.order = { type: 'attack', target: target.id };
        u.target = target;
        u.hasGoal = false;
        u.steerT = 0;
      } else movers.push(u);
    }
    if (movers.length) this.cmdMove(movers, target.x, target.y, false);
  }

  cmdAttackGround(units: Unit[], x: number, y: number): void {
    const bombers = units.filter((u) => u.def.bomber && !u.dead);
    for (const u of bombers) u.order = { type: 'attackGround', x, y };
    const rest = units.filter((u) => !u.def.bomber);
    if (rest.length) this.cmdMove(rest, x, y, true);
  }

  cmdGather(units: Unit[], pile: Pile): void {
    const rest: Unit[] = [];
    for (const u of units) {
      if (u.dead || u.container) continue;
      if (u.def.role !== 'gatherer') {
        rest.push(u);
        continue;
      }
      this.resetUnitState(u);
      u.order = { type: 'gather', pile: pile.id };
      u.gState = u.cargo >= (u.def.carry ?? 50) ? 'toDepot' : 'toPile';
      u.hasGoal = false;
    }
    if (rest.length) this.cmdMove(rest, pile.x, pile.y + 2.5);
  }

  cmdReturnCargo(units: Unit[]): void {
    for (const u of units) {
      if (u.def.role !== 'gatherer' || u.dead) continue;
      this.resetUnitState(u);
      const pile = this.nearestPile(u.x, u.y);
      u.order = { type: 'gather', pile: pile?.id ?? 0 };
      u.gState = u.cargo > 0 ? 'toDepot' : 'toPile';
      u.hasGoal = false;
    }
  }

  cmdBuild(units: Unit[], b: Building): void {
    const rest: Unit[] = [];
    for (const u of units) {
      if (u.dead || u.container) continue;
      if (u.def.role !== 'builder') {
        rest.push(u);
        continue;
      }
      this.resetUnitState(u);
      u.order = { type: 'build', target: b.id };
      u.hasGoal = false;
    }
    if (rest.length) this.cmdMove(rest, b.x, b.y + b.h / 2 + 1.5);
  }

  /** Infantry boards a transport or mans a gunner emplacement. */
  cmdEnter(units: Unit[], target: Entity): void {
    const rest: Unit[] = [];
    for (const u of units) {
      if (u.dead || u.container) continue;
      if (!u.def.infantry) {
        rest.push(u);
        continue;
      }
      this.resetUnitState(u);
      u.order = { type: 'enter', target: target.id };
      u.hasGoal = false;
    }
    if (rest.length) this.cmdMove(rest, target.x, target.y);
  }

  cmdStop(units: Unit[]): void {
    for (const u of units) {
      this.resetUnitState(u);
      u.order = { type: 'idle' };
      u.hasGoal = false;
      u.anchorX = u.x;
      u.anchorY = u.y;
    }
  }

  /** Does the right thing for whatever is under the cursor (Halo Wars style "X" button). */
  cmdSmart(owner: number, units: Unit[], x: number, y: number, hovered: Thing | null): string {
    const mine = units.filter((u) => u.owner === owner && !u.dead && !u.container);
    if (!mine.length) return '';
    if (hovered && hovered.kind !== 'pile' && this.hostile(owner, hovered.owner) && !hovered.dead && this.visibleTo(hovered, owner)) {
      this.cmdAttack(mine, hovered);
      return 'attack';
    }
    if (hovered && hovered.kind === 'pile') {
      if (mine.some((u) => u.def.role === 'gatherer')) {
        this.cmdGather(mine, hovered);
        return 'gather';
      }
    }
    if (hovered && hovered.kind === 'building' && hovered.owner === owner) {
      const b = hovered;
      const builders = mine.filter((u) => u.def.role === 'builder');
      if (builders.length && (!b.built || b.hp < b.maxHp)) {
        this.cmdBuild(builders, b);
        const rest = mine.filter((u) => u.def.role !== 'builder');
        if (rest.length) this.cmdMove(rest, x, y);
        return b.built ? 'repair' : 'build';
      }
      const inf = mine.filter((u) => u.def.infantry);
      if (b.def.garrison && b.built && !b.garrison && inf.length) {
        const first = inf.sort((a, c) => dist(a.x, a.y, b.x, b.y) - dist(c.x, c.y, b.x, b.y))[0];
        this.cmdEnter([first], b);
        const rest = mine.filter((u) => u !== first);
        if (rest.length) this.cmdMove(rest, b.x, b.y + b.h);
        return 'garrison';
      }
      const trucks = mine.filter((u) => u.def.role === 'gatherer');
      if (b.def.dropoff && trucks.length) {
        this.cmdReturnCargo(trucks);
        return 'return';
      }
    }
    if (hovered && hovered.kind === 'unit' && hovered.owner === owner && this.capacityOf(hovered) > 0) {
      const inf = mine.filter((u) => u.def.infantry);
      if (inf.length) {
        this.cmdEnter(inf.slice(0, Math.max(1, this.capacityOf(hovered) - hovered.passengers.length)), hovered);
        return 'board';
      }
    }
    this.cmdMove(mine, x, y);
    return 'move';
  }

  /** Halo Wars "Y": each unit type's special ability. Returns the ability used. */
  cmdAbility(owner: number, units: Unit[]): string {
    let used = '';
    for (const u of units) {
      if (u.dead || u.owner !== owner) continue;
      const ab = u.def.ability;
      if (!ab) continue;
      if (u.container && ab !== 'unload') continue;
      if (ab === 'unload') {
        if (u.passengers.length) {
          this.unload(u);
          used = 'unload';
        }
        continue;
      }
      if (ab === 'rearm') {
        u.order = { type: 'rearm' };
        used = 'rearm';
        continue;
      }
      if (u.abilityCd > 0) continue;
      if (ab === 'grenade') {
        const pick = { t: null as Entity | null, d: Infinity };
        this.forUnitsNear(u.x, u.y, GRENADE.range, (v, d) => {
          if (!this.hostile(owner, v.owner) || v.air || !this.visibleTo(v, owner) || d >= pick.d) return;
          if (v.owner === NEUTRAL && v.hostileTo[owner] < this.time) return;
          pick.t = v;
          pick.d = d;
        });
        if (!pick.t) {
          for (const b of this.buildings) {
            if (b.dead || !this.hostile(owner, b.owner) || !this.visibleTo(b, owner)) continue;
            if (b.owner === NEUTRAL && b.hostileTo[owner] < this.time) continue;
            const d = this.edgeDist(u.x, u.y, b);
            if (d <= GRENADE.range && d < pick.d) {
              pick.t = b;
              pick.d = d;
            }
          }
        }
        const t = pick.t;
        if (t) {
          this.launch(u, { name: 'Grenade', dmg: 'bomb', damage: GRENADE.damage, cooldown: 0, range: GRENADE.range, splash: GRENADE.splash, fx: 'arty', speed: 7 }, t, 1);
          if (this.collectFx) this.fx.push({ k: 'grenade', x: u.x, y: u.y, x2: t.x, y2: t.y });
          u.abilityCd = ABILITIES.grenade.cooldown;
          used = 'grenade';
        }
      } else if (ab === 'recon') {
        this.players[owner].recon.push({ x: u.x, y: u.y, until: this.time + RECON.duration });
        if (this.collectFx) this.fx.push({ k: 'recon', x: u.x, y: u.y, r: RECON.radius, owner });
        u.abilityCd = ABILITIES.recon.cooldown * (this.has(owner, 'sensors') ? UPGRADE.sensors.recon : 1);
        this.updateFog(owner);
        used = 'recon';
      } else if (ab === 'boost') {
        u.boostT = BOOST.duration;
        u.abilityCd = ABILITIES.boost.cooldown;
        used = 'boost';
      }
    }
    return used;
  }

  unload(t: Unit | Building): void {
    const list = t.kind === 'unit' ? t.passengers.splice(0) : t.garrison ? [t.garrison] : [];
    if (t.kind === 'building') t.garrison = null;
    let k = 0;
    for (const p of list) {
      const a = (k++ / Math.max(1, list.length)) * Math.PI * 2 + 0.5;
      const r = t.kind === 'building' ? t.radius + 0.9 : 1.1;
      const spot = this.map.nearestPassable(t.x + Math.cos(a) * r, t.y + Math.sin(a) * r, 'foot') ?? { x: t.x, y: t.y };
      p.container = 0;
      p.x = spot.x;
      p.y = spot.y;
      p.order = { type: 'idle' };
      p.hasGoal = false;
      p.anchorX = p.x;
      p.anchorY = p.y;
    }
  }

  // ---------------------------------------------------------------- production

  startConstruction(owner: number, key: BuildingKey, tx: number, ty: number, builders: Unit[]): Building | string {
    const chk = this.canPlace(owner, key, tx, ty);
    if (!chk.ok) return chk.reason;
    const pl = this.players[owner];
    const def = buildingDef(pl.faction, key);
    pl.supplies -= def.cost;
    pl.stats.spent += def.cost;
    const b = this.addBuilding(owner, key, tx, ty, false);
    this.cmdBuild(builders, b);
    return b;
  }

  /** Cancels a building that is still under construction (full refund). */
  cancelConstruction(b: Building): void {
    if (b.built || b.dead) return;
    const pl = this.players[b.owner];
    pl.supplies += b.def.cost;
    pl.stats.spent -= b.def.cost;
    b.dead = true;
    this.map.clearOcc(b.tx, b.ty, b.w, b.h, b.id);
  }

  queuedPop(owner: number): number {
    let n = 0;
    for (const b of this.buildings) {
      if (b.owner !== owner || b.dead) continue;
      for (const q of b.queue) if (q.kind === 'unit') n += unitDef(b.faction, q.key as UnitKey).pop;
    }
    return n;
  }

  /** Why a unit can't be queued right now, or ''. */
  unitBlocker(b: Building, key: UnitKey): string {
    const pl = this.players[b.owner];
    const def = unitDef(pl.faction, key);
    if (!b.built) return 'Under construction';
    if (b.queue.length >= 5) return 'Queue full';
    if (pl.supplies < def.cost) return 'Not enough supplies';
    if (pl.pop + this.queuedPop(b.owner) + def.pop > pl.popCap) return 'Unit cap reached - upgrade your HQ';
    return '';
  }

  queueUnit(b: Building, key: UnitKey): string {
    if (!b.def.produces?.includes(key)) return 'Cannot build that here';
    const why = this.unitBlocker(b, key);
    if (why) return why;
    const pl = this.players[b.owner];
    const def = unitDef(pl.faction, key);
    pl.supplies -= def.cost;
    pl.stats.spent += def.cost;
    b.queue.push({ kind: 'unit', key, t: 0, total: def.time, cost: def.cost });
    return '';
  }

  researchBlocker(b: Building, key: ResearchKey): string {
    const pl = this.players[b.owner];
    const def = researchDef(pl.faction, key);
    if (!b.built) return 'Under construction';
    if (pl.researched.has(key)) return 'Done';
    if (this.buildings.some((o) => o.owner === b.owner && !o.dead && o.queue.some((q) => q.key === key))) return 'In progress';
    if (def.tier && pl.tier !== def.tier - 1) return `Requires HQ Tier ${def.tier - 1}`;
    if (def.needsTier && pl.tier < def.needsTier) return `Requires HQ Tier ${def.needsTier}`;
    if (b.queue.length >= 5) return 'Queue full';
    if (pl.supplies < def.cost) return 'Not enough supplies';
    return '';
  }

  queueResearch(b: Building, key: ResearchKey): string {
    if (!b.def.research?.includes(key)) return 'Cannot research that here';
    const why = this.researchBlocker(b, key);
    if (why) return why;
    const pl = this.players[b.owner];
    const def = researchDef(pl.faction, key);
    pl.supplies -= def.cost;
    pl.stats.spent += def.cost;
    b.queue.push({ kind: 'research', key, t: 0, total: def.time, cost: def.cost });
    return '';
  }

  cancelLast(b: Building): boolean {
    const q = b.queue.pop();
    if (!q) return false;
    const pl = this.players[b.owner];
    pl.supplies += q.cost;
    pl.stats.spent -= q.cost;
    return true;
  }

  setRally(b: Building, x: number, y: number): void {
    b.rally = { x, y };
  }

  superweapon(owner: number): Building | null {
    return this.buildings.find((b) => b.owner === owner && !b.dead && b.built && b.def.superweapon) ?? null;
  }

  fireSuperweapon(owner: number, x: number, y: number): string {
    const b = this.superweapon(owner);
    if (!b) return 'No superweapon';
    if (b.charge > 0) return 'Still charging';
    if (!this.tileExplored(owner, x, y)) return 'You must target explored ground';
    const sw = b.def.superweapon!;
    b.charge = sw.charge;
    this.strikes.push({ x, y, t: 3.2, owner, faction: b.faction, radius: sw.radius, damage: sw.damage });
    if (this.collectFx) this.fx.push({ k: 'super', x, y, faction: b.faction, radius: sw.radius, phase: 'warn' });
    for (const p of this.activePlayers) {
      if (p.id === owner) this.alert(p.id, 'super-launch', `${b.def.name} fired!`, x, y, 'info', 1);
      else if (this.hostile(p.id, owner)) this.alert(p.id, 'super-incoming', 'WARNING: Enemy superweapon incoming!', x, y, 'warn', 1);
      else this.alert(p.id, 'super-ally', `Ally fired the ${b.def.name}`, x, y, 'info', 1);
    }
    return '';
  }

  // ---------------------------------------------------------------- alerts

  alert(owner: number, key: string, text: string, x: number, y: number, kind: Alert['kind'], cooldown: number): void {
    if (owner >= SLOTS) return;
    const pl = this.players[owner];
    if (!pl.active) return;
    const last = pl.alertT.get(key) ?? -999;
    if (this.time - last < cooldown) return;
    pl.alertT.set(key, this.time);
    this.alerts.push({ owner, text, x, y, kind, t: this.time, seq: ++this.alertSeq });
    if (this.alerts.length > 60) this.alerts.splice(0, this.alerts.length - 60);
  }

  // ---------------------------------------------------------------- main loop

  update(dt: number): void {
    if (this.over) return;
    this.time += dt;
    this.rebuildGrid();
    for (const p of this.players) {
      p.pop = 0;
      p.recon = p.recon.filter((r) => r.until > this.time);
    }
    for (const u of this.units) if (!u.dead) this.players[u.owner].pop += u.def.pop;

    for (const b of this.buildings) if (!b.dead) this.updateBuilding(b, dt);
    for (const u of this.units) if (!u.dead && !u.container) this.updateUnit(u, dt);
    this.separate(dt);
    this.updateProjectiles(dt);
    this.updateStrikes(dt);

    for (const c of this.controllers) c.update(dt);

    // fog of war (per team; the viewer's team updates fastest)
    const viewTeam = this.players[this.viewer]?.team;
    const done = new Set<number>();
    for (const p of this.players) {
      if (done.has(p.team)) continue;
      done.add(p.team);
      const left = (this.fogT.get(p.team) ?? Math.random() * 0.3) - dt;
      if (left <= 0) {
        this.fogT.set(p.team, p.team === viewTeam ? 0.1 : 0.3);
        this.updateFog(p.team);
      } else this.fogT.set(p.team, left);
    }

    this.cleanup();
    if (this.collectFx && this.fx.length > 3000) this.fx.splice(0, this.fx.length - 3000);
    if (!this.collectFx) this.fx.length = 0;
  }

  private cleanup(): void {
    let removed = false;
    for (const u of this.units) if (u.dead) this.byId.delete(u.id);
    for (const b of this.buildings) if (b.dead) this.byId.delete(b.id);
    if (this.units.some((u) => u.dead)) {
      this.units = this.units.filter((u) => !u.dead);
      removed = true;
    }
    if (this.buildings.some((b) => b.dead)) {
      this.buildings = this.buildings.filter((b) => !b.dead);
      removed = true;
    }
    if (removed) this.rebuildGrid();
  }

  // ---------------------------------------------------------------- buildings

  private updateBuilding(b: Building, dt: number): void {
    b.fireAnim = Math.max(0, b.fireAnim - dt);
    if (!b.built) return;

    // production queue (population is reserved when an item is queued)
    const q = b.queue[0];
    if (q) {
      q.t += dt;
      if (q.t >= q.total) {
        b.queue.shift();
        if (q.kind === 'unit') this.finishUnit(b, q.key as UnitKey);
        else this.finishResearch(b, q.key as ResearchKey);
      }
    }

    // passive income
    const dz = b.def.dropZone;
    if (dz) {
      b.dropT += dt;
      if (b.dropT >= dz.interval - 3.5 && !b.dropFx) {
        b.dropFx = true;
        if (this.collectFx) this.fx.push({ k: 'drop', x: b.x, y: b.y, faction: b.faction, owner: b.owner });
      }
      if (b.dropT >= dz.interval) {
        b.dropT = 0;
        b.dropFx = false;
        this.addIncome(b.owner, dz.amount, b.x, b.y);
      }
    }

    // superweapon charge
    if (b.def.superweapon && b.charge > 0) {
      b.charge = Math.max(0, b.charge - dt);
      if (b.charge === 0) {
        this.alert(b.owner, 'super-ready', `${b.def.name} is ready! (RT to fire)`, b.x, b.y, 'done', 5);
        for (const o of this.activePlayers)
          if (this.hostile(o.id, b.owner) && (this.visibleTo(b, o.id) || o.ghosts.has(b.id))) this.alert(o.id, 'enemy-super-ready', 'Enemy superweapon is charged!', b.x, b.y, 'warn', 5);
      }
    }

    // weapons (HQ gun, towers, defences, manned emplacements)
    const garrison = b.garrison;
    const weapons: WeaponDef[] = garrison ? garrison.def.weapons : b.def.weapons ?? [];
    if (!weapons.length) return;
    if (b.cds.length < weapons.length) b.cds = weapons.map(() => 0);
    const bonusRange = garrison ? 2 : 0;
    const maxRange = Math.max(...weapons.map((w) => w.range)) + bonusRange;
    b.scanT -= dt;
    if (b.scanT <= 0) {
      b.scanT = 0.3;
      b.target = this.findTarget(b, b.x, b.y, maxRange + b.radius, weapons, null, bonusRange);
    }
    for (let i = 0; i < weapons.length; i++) {
      b.cds[i] -= dt;
      const w = weapons[i];
      let t = b.target;
      if (!t || t.dead || !weaponCanHit(w, t.armor) || !this.inRange(b, w, t, bonusRange)) {
        t = this.findTarget(b, b.x, b.y, w.range + bonusRange + b.radius, [w], null, bonusRange, true);
      }
      if (!t) continue;
      if (w.turret || garrison) {
        const want = Math.atan2(t.y - b.y, t.x - b.x);
        b.turret = turnTowards(b.turret, want, dt * 4);
        if (Math.abs(wrapAngle(want - b.turret)) > 0.3) continue;
      }
      if (b.cds[i] > 0) continue;
      b.cds[i] = w.cooldown * (0.92 + Math.random() * 0.16);
      const mult = garrison ? 1.5 * (w.perMember ? garrison.shooters : 1) : 1;
      this.launch(b, w, t, mult);
    }
  }

  private finishUnit(b: Building, key: UnitKey): void {
    const pl = this.players[b.owner];
    const def = unitDef(b.faction, key);
    let sx = b.x;
    let sy = b.y;
    if (def.move !== 'air') {
      // roll out of the side facing the rally point, or the map centre
      const tx = b.rally?.x ?? this.map.w / 2;
      const ty = b.rally?.y ?? this.map.h / 2;
      const a = Math.atan2(ty - b.y, tx - b.x);
      sx = b.x + Math.cos(a) * (b.w / 2 + 0.8);
      sy = b.y + Math.sin(a) * (b.h / 2 + 0.8);
    }
    const u = this.spawnUnit(b.owner, key, sx, sy);
    u.angle = Math.atan2(sy - b.y, sx - b.x);
    pl.stats.unitsBuilt++;
    if (def.role === 'gatherer') {
      const pile = this.findPileFor(u);
      if (pile) this.cmdGather([u], pile);
    } else if (b.rally) {
      this.cmdMove([u], b.rally.x, b.rally.y);
    } else if (def.move !== 'air') {
      this.cmdMove([u], sx + Math.cos(u.angle) * 2, sy + Math.sin(u.angle) * 2);
    } else {
      u.anchorX = b.x;
      u.anchorY = b.y;
    }
    this.alert(b.owner, 'unit-ready', `${def.name} ready`, u.x, u.y, 'done', 4);
  }

  private finishResearch(b: Building, key: ResearchKey): void {
    const pl = this.players[b.owner];
    const def = researchDef(b.faction, key);
    pl.researched.add(key);
    if (def.tier) pl.tier = Math.max(pl.tier, def.tier);
    for (const u of this.units) if (u.owner === b.owner && !u.dead) this.applyUpgrades(u);
    this.alert(b.owner, 'research', `${def.name} complete`, b.x, b.y, 'done', 0.5);
  }

  private completeConstruction(b: Building): void {
    b.built = true;
    b.progress = 1;
    const pl = this.players[b.owner];
    pl.stats.structuresBuilt++;
    if (b.def.superweapon) b.charge = b.def.superweapon.charge;
    this.alert(b.owner, 'built-' + b.id, `${b.def.name} complete`, b.x, b.y, 'done', 0);
    if (b.def.freeUnit) {
      const u = this.spawnUnit(b.owner, b.def.freeUnit, b.x, b.y + b.h / 2 + 0.8);
      const pile = this.findPileFor(u);
      if (pile) this.cmdGather([u], pile);
    }
  }

  private addIncome(owner: number, amt: number, x: number, y: number): void {
    const pl = this.players[owner];
    pl.supplies += amt;
    pl.stats.gathered += amt;
    pl.incomeLog.push({ t: this.time, amt });
    if (pl.incomeLog.length > 200) pl.incomeLog.splice(0, 100);
    if (this.collectFx && amt >= 100) this.fx.push({ k: 'text', x, y, text: `+${Math.round(amt)}`, color: '#ffd84a', owner });
  }

  /** Supplies per minute over the last minute. */
  incomeRate(owner: number): number {
    const pl = this.players[owner];
    let s = 0;
    for (const e of pl.incomeLog) if (this.time - e.t <= 60) s += e.amt;
    return s * (60 / Math.min(60, Math.max(10, this.time)));
  }

  // ---------------------------------------------------------------- units

  private updateUnit(u: Unit, dt: number): void {
    u.abilityCd = Math.max(0, u.abilityCd - dt);
    u.boostT = Math.max(0, u.boostT - dt);
    u.fireAnim = Math.max(0, u.fireAnim - dt);

    // field medics
    if (u.medic && u.hp < u.maxHp && this.time - u.lastHurtT > 5 && this.time - u.lastFireT > 3) {
      u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.04 * dt);
    }

    if (u.def.bomber) {
      this.updateBomber(u, dt);
      return;
    }

    const o = u.order;
    const hasWeapons = u.def.weapons.length > 0;
    if (hasWeapons) {
      u.scanT -= dt;
      if (u.scanT <= 0) {
        u.scanT = 0.25 + Math.random() * 0.1;
        const maxRange = Math.max(...u.def.weapons.map((w) => w.range)) + this.rangeBonus(u);
        const acquire = o.type === 'move' && !o.attackMove ? maxRange : Math.max(this.sightOf(u), maxRange);
        if (o.type !== 'attack') u.target = this.findTarget(u, u.x, u.y, acquire, u.def.weapons, o);
      }
    }

    // idle builders look after nearby structures by themselves
    if (o.type === 'idle' && u.def.role === 'builder') {
      u.scanT -= dt;
      if (u.scanT <= 0) {
        u.scanT = 1 + Math.random() * 0.3;
        let job: Building | null = null;
        let bd = 10;
        for (const b of this.buildings) {
          if (b.dead || b.owner !== u.owner || (b.built && b.hp >= b.maxHp * 0.97)) continue;
          const d = this.edgeDist(u.x, u.y, b);
          if (d < bd) {
            bd = d;
            job = b;
          }
        }
        if (job) {
          u.order = { type: 'build', target: job.id };
          u.hasGoal = false;
          return;
        }
      }
    }

    switch (o.type) {
      case 'idle': {
        const t = u.target;
        if (hasWeapons && t && !t.dead) {
          const inR = u.def.weapons.some((w) => weaponCanHit(w, t.armor) && this.inRange(u, w, t, 0));
          const leash = u.territorial ? (this.time < u.raidUntil ? 40 : 10) : 8;
          if (inR) this.stopMoving(u);
          else if (dist(u.anchorX, u.anchorY, t.x, t.y) < leash) this.chaseTo(u, t);
          else this.returnToAnchor(u);
        } else this.returnToAnchor(u);
        this.stepMove(u, dt);
        break;
      }
      case 'move': {
        const t = u.target;
        if (o.attackMove && hasWeapons && t && !t.dead) {
          const inR = u.def.weapons.some((w) => weaponCanHit(w, t.armor) && this.inRange(u, w, t, 0));
          if (inR) this.stopMoving(u);
          else this.chaseTo(u, t);
          this.stepMove(u, dt);
          break;
        }
        if (!u.hasGoal || u.goalX !== o.x || u.goalY !== o.y) {
          if (dist(u.x, u.y, o.x, o.y) > 0.6) this.setGoal(u, o.x, o.y, 0.3, o.gx, o.gy);
          else {
            this.arrive(u);
            break;
          }
        }
        if (this.stepMove(u, dt)) this.arrive(u);
        break;
      }
      case 'attack': {
        const t = this.entity(o.target);
        if (!t || t.dead || (t.kind === 'unit' && t.container) || !this.visibleTo(t, u.owner)) {
          // lost sight: move to where we last saw it, then look around
          if (t && !t.dead && !(t.kind === 'unit' && t.container)) {
            this.cmdMove([u], t.x, t.y, true);
          } else {
            u.order = { type: 'idle' };
            u.anchorX = u.x;
            u.anchorY = u.y;
          }
          break;
        }
        u.target = t;
        const inR = u.def.weapons.some((w) => weaponCanHit(w, t.armor) && this.inRange(u, w, t, 0));
        if (inR) this.stopMoving(u);
        else this.chaseTo(u, t);
        this.stepMove(u, dt);
        break;
      }
      case 'gather':
        this.updateGatherer(u, dt);
        break;
      case 'build':
        this.updateBuilder(u, dt);
        break;
      case 'enter': {
        const t = this.entity(o.target);
        const full = !t || t.dead || (t.kind === 'unit' ? t.passengers.length >= this.capacityOf(t) : !t.built || !!t.garrison);
        if (full) {
          u.order = { type: 'idle' };
          u.anchorX = u.x;
          u.anchorY = u.y;
          break;
        }
        const flying = t!.kind === 'unit' && t!.air;
        const d = flying ? dist(u.x, u.y, t!.x, t!.y) : this.edgeDist(u.x, u.y, t!);
        if (d < (flying ? 2.4 : 1.1)) {
          this.board(u, t!);
          break;
        }
        // a hovering dropship comes down to meet its passengers
        if (flying && t!.kind === 'unit' && t!.order.type === 'idle' && d > 3 && dist(t!.goalX, t!.goalY, u.x, u.y) > 2) {
          this.cmdMove([t as Unit], u.x, u.y);
        }
        if (!u.hasGoal || dist(u.goalX, u.goalY, t!.x, t!.y) > 1) this.setGoal(u, t!.x, t!.y, 0.6);
        this.stepMove(u, dt);
        break;
      }
      case 'attackGround':
      case 'rearm':
        u.order = { type: 'idle' };
        break;
    }

    if (hasWeapons) this.fireWeapons(u, dt);
  }

  private board(u: Unit, t: Entity): void {
    u.container = t.id;
    u.hasGoal = false;
    u.order = { type: 'idle' };
    u.target = null;
    if (t.kind === 'unit') t.passengers.push(u);
    else t.garrison = u;
  }

  private arrive(u: Unit): void {
    u.order = { type: 'idle' };
    u.hasGoal = false;
    u.moving = false;
    u.anchorX = u.x;
    u.anchorY = u.y;
  }

  private stopMoving(u: Unit): void {
    u.hasGoal = false;
    u.moving = false;
  }

  private chaseTo(u: Unit, t: Entity): void {
    if (!u.hasGoal || dist(u.goalX, u.goalY, t.x, t.y) > 1.0) this.setGoal(u, t.x, t.y, 0.5);
  }

  private returnToAnchor(u: Unit): void {
    if (!u.hasGoal && dist(u.x, u.y, u.anchorX, u.anchorY) > 2.5) this.setGoal(u, u.anchorX, u.anchorY, 0.8);
  }

  private setGoal(u: Unit, x: number, y: number, arrive = 0.3, fx?: number, fy?: number): void {
    u.goalX = x;
    u.goalY = y;
    u.hasGoal = true;
    u.arrive = arrive;
    u.stuckT = 0;
    u.progressX = u.x;
    u.progressY = u.y;
    u.steerT = 0;
    u.field = u.air ? null : this.paths.field(fx ?? x, fy ?? y, u.def.move);
  }

  /** Moves a unit towards its goal; returns true when it has arrived (or has no goal). */
  private stepMove(u: Unit, dt: number): boolean {
    if (!u.hasGoal) {
      u.moving = false;
      return true;
    }
    const d = dist(u.x, u.y, u.goalX, u.goalY);
    if (d <= u.arrive) {
      u.hasGoal = false;
      u.moving = false;
      return true;
    }
    u.steerT -= dt;
    if (u.steerT <= 0) {
      u.steerT = 0.25 + Math.random() * 0.1;
      this.computeSteer(u);
    }
    const desired = Math.atan2(u.steerY - u.y, u.steerX - u.x);
    const inf = u.def.role === 'infantry';
    const turnRate = inf ? 12 : u.air ? 3.5 : 4.5;
    u.angle = turnTowards(u.angle, desired, turnRate * dt);
    const align = Math.cos(wrapAngle(desired - u.angle));
    let speed = u.def.speed * this.map.speedMult(u.x, u.y, u.def.move) * (u.boostT > 0 ? BOOST.mult : 1);
    if (!inf && !u.air) speed *= Math.max(0, align) * 0.8 + 0.2;
    const sd = dist(u.x, u.y, u.steerX, u.steerY);
    const step = Math.min(speed * dt, Math.max(sd, 0.01), d);
    const nx = u.x + Math.cos(desired) * step;
    const ny = u.y + Math.sin(desired) * step;
    this.tryMove(u, nx, ny);
    u.moving = true;

    // stuck detection
    u.stuckT += dt;
    if (u.stuckT > 1.2) {
      const moved = dist(u.x, u.y, u.progressX, u.progressY);
      u.progressX = u.x;
      u.progressY = u.y;
      u.stuckT = 0;
      if (moved < 0.25 * u.def.speed) {
        u.stuckCount++;
        if (d < 2.5 || u.stuckCount > 4) {
          u.stuckCount = 0;
          u.hasGoal = false;
          u.moving = false;
          return true;
        }
        // wiggle
        const a = Math.random() * Math.PI * 2;
        u.steerX = u.x + Math.cos(a);
        u.steerY = u.y + Math.sin(a);
        u.steerT = 0.4;
      } else u.stuckCount = 0;
    }
    return false;
  }

  private computeSteer(u: Unit): void {
    const map = this.map;
    if (u.air || map.lineClear(u.x, u.y, u.goalX, u.goalY, u.def.move)) {
      u.steerX = u.goalX;
      u.steerY = u.goalY;
      return;
    }
    const f = u.field;
    if (!f) {
      u.steerX = u.goalX;
      u.steerY = u.goalY;
      return;
    }
    const tx = Math.floor(u.x);
    const ty = Math.floor(u.y);
    let cur = ty * map.w + tx;
    let bx = NaN;
    let by = NaN;
    let fx = NaN;
    let fy = NaN;
    for (let k = 0; k < 10; k++) {
      const nxt = f.next(map, cur);
      if (nxt < 0) break;
      cur = nxt;
      const cx = (cur % map.w) + 0.5;
      const cy = Math.floor(cur / map.w) + 0.5;
      if (k === 0) {
        fx = cx;
        fy = cy;
      }
      if (map.lineClear(u.x, u.y, cx, cy, u.def.move, 0.22)) {
        bx = cx;
        by = cy;
      } else if (!isNaN(bx)) break;
    }
    if (!isNaN(bx)) {
      u.steerX = bx;
      u.steerY = by;
    } else if (!isNaN(fx)) {
      u.steerX = fx;
      u.steerY = fy;
    } else {
      u.steerX = u.goalX;
      u.steerY = u.goalY;
    }
  }

  private tryMove(u: Unit, nx: number, ny: number): void {
    nx = clamp(nx, 0.3, this.map.w - 0.3);
    ny = clamp(ny, 0.3, this.map.h - 0.3);
    if (u.air) {
      u.x = nx;
      u.y = ny;
      return;
    }
    const cls = u.def.move;
    if (this.map.passableXY(nx, ny, cls)) {
      u.x = nx;
      u.y = ny;
    } else if (this.map.passableXY(nx, u.y, cls)) u.x = nx;
    else if (this.map.passableXY(u.x, ny, cls)) u.y = ny;
  }

  /** Pushes overlapping units apart. */
  private separate(dt: number): void {
    for (const u of this.units) {
      if (u.dead || u.container) continue;
      const r = u.air ? 0.55 : u.radius;
      this.forUnitsNear(u.x, u.y, 1.8, (v, d) => {
        if (v.id <= u.id || v.air !== u.air) return;
        const minD = (r + (v.air ? 0.55 : v.radius)) * SAFE_DIST;
        if (d >= minD) return;
        let dx = v.x - u.x;
        let dy = v.y - u.y;
        if (d < 0.001) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
        }
        const len = Math.hypot(dx, dy) || 1;
        const push = Math.min(minD - d, 3 * dt) * (u.air ? 0.5 : 1);
        // the unit that is standing still yields more
        const wu = u.moving && !v.moving ? 0.2 : !u.moving && v.moving ? 0.8 : 0.5;
        const ux = u.x - (dx / len) * push * wu;
        const uy = u.y - (dy / len) * push * wu;
        const vx = v.x + (dx / len) * push * (1 - wu);
        const vy = v.y + (dy / len) * push * (1 - wu);
        if (u.air || this.map.passableXY(ux, uy, u.def.move)) {
          u.x = ux;
          u.y = uy;
        }
        if (v.air || this.map.passableXY(vx, vy, v.def.move)) {
          v.x = vx;
          v.y = vy;
        }
      });
      if (!u.air && !this.map.passableXY(u.x, u.y, u.def.move)) {
        const p = this.map.nearestPassable(u.x, u.y, u.def.move, 6);
        if (p) {
          u.x = p.x;
          u.y = p.y;
        }
      }
    }
  }

  // ---------------------------------------------------------------- economy units

  private releasePile(u: Unit): void {
    const p = this.byId.get(u.loadingPile);
    if (p && p.kind === 'pile') p.loading = Math.max(0, p.loading - 1);
    u.loadingPile = 0;
    if (u.gState === 'loading') u.gState = 'toPile';
  }

  /** Best supply cache for a truck: close to one of its owner's drop-off points, outside hostile territory. */
  findPileFor(u: Unit): Pile | null {
    const drops = this.buildings.filter((b) => b.owner === u.owner && !b.dead && b.built && b.def.dropoff);
    let best: Pile | null = null;
    let bs = Infinity;
    for (const p of this.piles) {
      if (p.amount <= 0 || this.inZone(p.x, p.y, 1)) continue;
      let dd = Infinity;
      for (const b of drops) dd = Math.min(dd, distToRect(p.x, p.y, b.tx, b.ty, b.w, b.h));
      const score = dd * 1.5 + dist(u.x, u.y, p.x, p.y) * 0.3 + p.loading * 3;
      if (score < bs) {
        bs = score;
        best = p;
      }
    }
    return best;
  }

  nearestDropoff(owner: number, x: number, y: number): Building | null {
    let best: Building | null = null;
    let bd = Infinity;
    for (const b of this.buildings) {
      if (b.owner !== owner || b.dead || !b.built || !b.def.dropoff) continue;
      const d = distToRect(x, y, b.tx, b.ty, b.w, b.h);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  private updateGatherer(u: Unit, dt: number): void {
    const o = u.order as { type: 'gather'; pile: number };
    let pile = this.byId.get(o.pile) as Pile | undefined;
    const carry = u.def.carry ?? 50;
    switch (u.gState) {
      case 'toPile': {
        if (!pile || pile.amount <= 0) {
          const np = this.findPileFor(u);
          if (!np) {
            if (u.cargo > 0) u.gState = 'toDepot';
            else {
              u.order = { type: 'idle' };
              u.anchorX = u.x;
              u.anchorY = u.y;
            }
            return;
          }
          pile = np;
          o.pile = np.id;
          u.hasGoal = false;
        }
        const d = this.edgeDist(u.x, u.y, pile);
        if (d <= 0.95) {
          this.stopMoving(u);
          if (pile.loading < 3) {
            pile.loading++;
            u.loadingPile = pile.id;
            u.gState = 'loading';
            u.gTimer = u.def.loadTime ?? 4;
          }
        } else {
          if (!u.hasGoal) this.setGoal(u, pile.x, pile.y, 0.9);
          this.stepMove(u, dt);
          if (!u.hasGoal && this.edgeDist(u.x, u.y, pile) > 0.95) this.setGoal(u, pile.x, pile.y, 0.9);
        }
        break;
      }
      case 'loading': {
        u.gTimer -= dt;
        if (!pile || pile.amount <= 0) {
          this.releasePile(u);
          u.gState = u.cargo > 0 ? 'toDepot' : 'toPile';
          return;
        }
        if (u.gTimer <= 0) {
          const take = Math.min(carry - u.cargo, pile.amount);
          pile.amount -= take;
          u.cargo += take;
          this.releasePile(u);
          u.gState = 'toDepot';
          u.hasGoal = false;
          if (pile.amount <= 0) {
            this.map.clearOcc(pile.tx, pile.ty, 2, 2, pile.id);
            this.alert(u.owner, 'pile-empty-' + pile.id, `${pile.label} is depleted`, pile.x, pile.y, 'warn', 999);
          }
        }
        break;
      }
      case 'toDepot': {
        const depot = this.nearestDropoff(u.owner, u.x, u.y);
        if (!depot) {
          this.stopMoving(u);
          return;
        }
        const d = this.edgeDist(u.x, u.y, depot);
        if (d <= 1.0) {
          this.stopMoving(u);
          u.gState = 'unloading';
          u.gTimer = 0.6;
        } else {
          if (!u.hasGoal || dist(u.goalX, u.goalY, depot.x, depot.y) > 0.5) this.setGoal(u, depot.x, depot.y, 1.0);
          this.stepMove(u, dt);
          if (!u.hasGoal && this.edgeDist(u.x, u.y, depot) > 1.0) this.setGoal(u, depot.x, depot.y, 1.0);
        }
        break;
      }
      case 'unloading': {
        u.gTimer -= dt;
        if (u.gTimer <= 0) {
          const pl = this.players[u.owner];
          const amt = u.cargo * pl.gatherMul;
          u.cargo = 0;
          this.addIncome(u.owner, amt, u.x, u.y);
          u.gState = 'toPile';
          u.hasGoal = false;
        }
        break;
      }
    }
  }

  private updateBuilder(u: Unit, dt: number): void {
    const o = u.order as { type: 'build'; target: number };
    const b = this.entity(o.target);
    if (!b || b.kind !== 'building' || b.dead || b.owner !== u.owner || (b.built && b.hp >= b.maxHp)) {
      // look for other unfinished work nearby
      const next = this.buildings.find((x) => x.owner === u.owner && !x.dead && !x.built && dist(x.x, x.y, u.x, u.y) < 10);
      if (next) {
        o.target = next.id;
        return;
      }
      u.order = { type: 'idle' };
      u.anchorX = u.x;
      u.anchorY = u.y;
      u.hasGoal = false;
      return;
    }
    const d = this.edgeDist(u.x, u.y, b);
    if (d > 1.3) {
      if (!u.hasGoal) this.setGoal(u, b.x, b.y, 1.2);
      this.stepMove(u, dt);
      if (!u.hasGoal && this.edgeDist(u.x, u.y, b) > 1.3) {
        // couldn't get there: try approaching from another side
        const a = Math.random() * Math.PI * 2;
        this.setGoal(u, b.x + Math.cos(a) * (b.w / 2 + 1), b.y + Math.sin(a) * (b.h / 2 + 1), 0.6);
      }
      return;
    }
    this.stopMoving(u);
    u.angle = turnTowards(u.angle, Math.atan2(b.y - u.y, b.x - u.x), dt * 4);
    const rate = (u.def.buildRate ?? 1) * (this.has(u.owner, 'rapid') ? UPGRADE.rapid.build : 1);
    // several builders speed things up, with diminishing returns
    const helpers = this.units.filter((v) => v.owner === u.owner && v.order.type === 'build' && v.order.target === b.id && !v.moving).length;
    const share = helpers > 1 ? (1 + 0.6 * (helpers - 1)) / helpers : 1;
    if (!b.built) {
      const dp = (dt * rate * share) / b.def.time;
      b.progress = Math.min(1, b.progress + dp);
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.92 * dp);
      if (b.progress >= 1) this.completeConstruction(b);
    } else {
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.025 * dt * rate * share);
    }
    u.fireAnim = 0.1;
    if (this.collectFx && Math.random() < dt * 3) this.fx.push({ k: 'build', x: b.x + (Math.random() - 0.5) * b.w, y: b.y + (Math.random() - 0.5) * b.h });
  }

  private updateBomber(u: Unit, dt: number): void {
    const o = u.order;
    let tx = u.anchorX;
    let ty = u.anchorY;
    let wantDrop = false;
    let hover = false;
    if (o.type === 'attack') {
      const t = this.entity(o.target);
      if (!t || t.dead) {
        u.order = u.ammo > 0 ? { type: 'idle' } : { type: 'rearm' };
        return;
      }
      tx = t.x;
      ty = t.y;
      wantDrop = true;
    } else if (o.type === 'attackGround') {
      tx = o.x;
      ty = o.y;
      wantDrop = true;
    } else if (o.type === 'move') {
      tx = o.x;
      ty = o.y;
      if (dist(u.x, u.y, tx, ty) < 1) {
        u.order = { type: 'idle' };
        u.anchorX = tx;
        u.anchorY = ty;
      }
    } else if (o.type === 'rearm') {
      const base = this.nearestAirbase(u);
      const home = base ?? this.players[u.owner].hq;
      if (!home) return;
      const pad = base ? this.padSpot(base, u) : { x: home.x, y: home.y - 2 };
      tx = pad.x;
      ty = pad.y;
      if (dist(u.x, u.y, tx, ty) < 0.5) {
        hover = true;
        u.x = tx;
        u.y = ty;
        if (base) {
          u.rearmT += dt;
          if (u.rearmT >= 12) {
            u.ammo = 1;
            u.rearmT = 0;
            u.order = { type: 'idle' };
            u.anchorX = tx;
            u.anchorY = ty;
          }
        }
      }
    } else {
      // idle: park on the pad if at a base, otherwise circle
      const base = this.nearestAirbase(u);
      if (base && dist(u.anchorX, u.anchorY, base.x, base.y) < 3) {
        const pad = this.padSpot(base, u);
        tx = pad.x;
        ty = pad.y;
        if (dist(u.x, u.y, tx, ty) < 0.5) {
          hover = true;
          u.x = tx;
          u.y = ty;
        }
      } else {
        const a = this.time * 0.9 + u.id;
        tx = u.anchorX + Math.cos(a) * 2.5;
        ty = u.anchorY + Math.sin(a) * 2.5;
      }
      if (u.ammo <= 0) u.order = { type: 'rearm' };
    }
    if (wantDrop && u.ammo <= 0) {
      u.order = { type: 'rearm' };
      return;
    }
    if (hover) {
      u.moving = false;
      u.angle = turnTowards(u.angle, -Math.PI / 2, dt * 2);
      return;
    }
    const want = Math.atan2(ty - u.y, tx - u.x);
    u.angle = turnTowards(u.angle, want, dt * 2.8);
    const d = dist(u.x, u.y, tx, ty);
    const slow = o.type === 'rearm' && d < 3 ? Math.max(0.25, d / 3) : 1;
    const sp = u.def.speed * slow * (o.type === 'idle' ? 0.55 : 1);
    u.x = clamp(u.x + Math.cos(u.angle) * sp * dt, 0.3, this.map.w - 0.3);
    u.y = clamp(u.y + Math.sin(u.angle) * sp * dt, 0.3, this.map.h - 0.3);
    u.moving = true;
    if (wantDrop && d < 1.6) {
      const w = u.def.weapons[0];
      this.projectiles.push({
        fx: 'bomb', x: u.x, y: u.y, sx: u.x, sy: u.y, tx, ty, target: 0, speed: 0, damage: w.damage, dmg: w.dmg, splash: w.splash ?? 2,
        owner: u.owner, src: u.id, t: 0, dur: 0.55, toAir: false, faction: u.faction,
      });
      u.ammo = 0;
      u.lastFireT = this.time;
      u.order = { type: 'rearm' };
    }
  }

  private nearestAirbase(u: Unit): Building | null {
    let best: Building | null = null;
    let bd = Infinity;
    for (const b of this.buildings) {
      if (b.owner !== u.owner || b.dead || !b.built || !b.def.pads) continue;
      const d = dist(u.x, u.y, b.x, b.y);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  private padSpot(b: Building, u: Unit): { x: number; y: number } {
    const bombers = this.units.filter((v) => v.owner === u.owner && v.def.bomber && !v.dead).sort((a, c) => a.id - c.id);
    const idx = Math.max(0, bombers.indexOf(u));
    const pads = b.def.pads ?? 2;
    const k = idx % pads;
    const layer = Math.floor(idx / pads);
    return { x: b.tx + 1 + k * 2, y: b.ty + b.h - 1.2 - layer * 1.4 };
  }

  // ---------------------------------------------------------------- combat

  private inRange(a: Unit | Building, w: WeaponDef, t: Entity, bonus: number): boolean {
    const d = this.edgeDist(a.x, a.y, t) - (a.kind === 'building' ? a.radius : 0);
    if (w.minRange && d < w.minRange) return false;
    return d <= w.range + bonus + (a.kind === 'unit' ? this.rangeBonus(a) : 0);
  }

  /** May `a` (owned by its owner) pick `t` as a target on its own initiative? */
  private canAutoTarget(a: Unit | Building, t: Entity, order: Unit['order'] | null): boolean {
    if (t.dead || !this.hostile(a.owner, t.owner)) return false;
    if (t.kind === 'unit' && t.container) return false;
    if (!this.visibleTo(t, a.owner)) return false;
    if (t.owner === NEUTRAL && a.owner !== NEUTRAL) {
      // leave the Marauders alone unless they started it or we were told to attack
      const told = order && order.type === 'move' && order.attackMove && this.inZone(order.gx, order.gy, 3);
      if (t.hostileTo[a.owner] < this.time && !told) return false;
    }
    if (a.owner === NEUTRAL && a.kind === 'unit' && a.territorial && this.time > a.raidUntil) {
      if (!this.inCamp(a.camp, t.x, t.y, 0) && t.hostileTo[NEUTRAL] < this.time) return false;
    }
    return true;
  }

  private findTarget(
    a: Unit | Building,
    x: number,
    y: number,
    range: number,
    weapons: WeaponDef[],
    order: Unit['order'] | null,
    bonus = 0,
    strict = false,
  ): Entity | null {
    let best: Entity | null = null;
    let bs = -Infinity;
    const consider = (t: Entity, d: number) => {
      if (!this.canAutoTarget(a, t, order)) return;
      let m = 0;
      let inR = false;
      for (const w of weapons) {
        if (!weaponCanHit(w, t.armor)) continue;
        m = Math.max(m, damageMult(w.dmg, t.armor));
        if (this.inRange(a, w, t, bonus)) inR = true;
      }
      if (m <= 0) return;
      if (strict && !inR) return;
      let score = m * 10 - d * 0.7 + (inR ? 6 : 0);
      if (t.kind === 'building') score -= t.def.weapons?.length || t.garrison ? 2 : 8;
      else if (t.def.weapons.length === 0) score -= 3;
      if (t === a.target) score += 2;
      if (score > bs) {
        bs = score;
        best = t;
      }
    };
    this.forUnitsNear(x, y, range + 1, (u, d) => consider(u, d));
    for (const b of this.buildings) {
      if (b.dead) continue;
      const d = this.edgeDist(x, y, b);
      if (d <= range) consider(b, d);
    }
    return best;
  }

  private fireWeapons(u: Unit, dt: number): void {
    const forced = u.order.type === 'attack' ? this.entity(u.order.target) : null;
    for (let i = 0; i < u.def.weapons.length; i++) {
      const w = u.def.weapons[i];
      u.cds[i] -= dt;
      let t: Entity | null = null;
      if (forced && !forced.dead && weaponCanHit(w, forced.armor) && this.inRange(u, w, forced, 0)) t = forced;
      else if (u.target && !u.target.dead && weaponCanHit(w, u.target.armor) && this.inRange(u, w, u.target, 0) && this.visibleTo(u.target, u.owner)) t = u.target;
      else if (u.cds[i] <= 0 && Math.random() < 0.25) t = this.findTarget(u, u.x, u.y, w.range + 1, [w], u.order, 0, true);
      if (!t || (t.kind === 'unit' && t.container)) continue;
      const want = Math.atan2(t.y - u.y, t.x - u.x);
      if (w.turret) {
        u.turret = turnTowards(u.turret, want, dt * 5);
        if (Math.abs(wrapAngle(want - u.turret)) > 0.3) continue;
      } else if (!u.moving) {
        u.angle = turnTowards(u.angle, want, dt * (u.def.role === 'infantry' ? 10 : 4));
        if (u.def.role !== 'infantry' && Math.abs(wrapAngle(want - u.angle)) > 0.6) continue;
      }
      if (u.cds[i] > 0) continue;
      u.cds[i] = w.cooldown * (0.9 + Math.random() * 0.2) * (u.key === 'rocket' && this.has(u.owner, 'speedload') ? UPGRADE.speedload.reload : 1);
      this.launch(u, w, t, w.perMember ? u.shooters : 1);
    }
    if (!u.def.weapons.some((w) => w.turret)) u.turret = u.angle;
    else if (!u.target || u.target.dead) u.turret = turnTowards(u.turret, u.angle, dt * 2);
  }

  /** Fires a weapon: instant hits for guns and beams, projectiles for everything else. */
  private launch(a: Unit | Building, w: WeaponDef, t: Entity, mult: number): void {
    a.lastFireT = this.time;
    a.fireAnim = 0.12;
    if (a.owner === NEUTRAL && t.owner !== NEUTRAL) {
      // the Marauders opened fire, so the victim may shoot back freely
      a.hostileTo[t.owner] = this.time + 8;
    }
    if (t.owner === NEUTRAL && a.owner !== NEUTRAL) {
      t.hostileTo[a.owner] = this.time + 10;
      a.hostileTo[NEUTRAL] = this.time + 10;
    }
    const damage = w.damage * mult;
    const toAir = t.kind === 'unit' && t.air;
    if (!w.speed) {
      if (this.collectFx)
        this.fx.push({ k: 'shot', fx: w.fx, x: a.x, y: a.y, x2: t.x + (Math.random() - 0.5) * 0.4, y2: t.y + (Math.random() - 0.5) * 0.4, owner: a.owner, faction: a.faction, air: toAir });
      this.damage(t, damage, w.dmg, a.owner, a.id, a.x, a.y);
      if (w.splash) this.splash(t.x, t.y, w.splash, damage, w.dmg, a.owner, a.id, a.x, a.y, t);
      return;
    }
    const d = dist(a.x, a.y, t.x, t.y);
    const dur = Math.max(0.08, d / w.speed);
    const p: Projectile = {
      fx: w.fx, x: a.x, y: a.y, sx: a.x, sy: a.y, tx: t.x, ty: t.y, target: t.id, speed: w.speed, damage, dmg: w.dmg, splash: w.splash ?? 0,
      owner: a.owner, src: a.id, t: 0, dur, toAir, faction: a.faction,
    };
    // aircraft jammers make guided weapons lose their lock
    const guided = w.fx === 'missile' || w.fx === 'rocket' || w.fx === 'plasma';
    if (guided && toAir && this.has(t.owner, 'jammer') && Math.random() < UPGRADE.jammer.chance) {
      const ang = Math.random() * Math.PI * 2;
      const off = 1.6 + Math.random() * 1.4;
      p.jammed = true;
      p.target = 0;
      p.tx = t.x + Math.cos(ang) * off;
      p.ty = t.y + Math.sin(ang) * off;
      if (this.collectFx) this.fx.push({ k: 'text', x: t.x, y: t.y - 1.2, text: 'jammed', color: '#9fe8ff', owner: t.owner });
    }
    this.projectiles.push(p);
    if (this.collectFx) this.fx.push({ k: 'shot', fx: w.fx, x: a.x, y: a.y, x2: t.x, y2: t.y, owner: a.owner, faction: a.faction, air: toAir });
  }

  private updateProjectiles(dt: number): void {
    const keep: Projectile[] = [];
    for (const p of this.projectiles) {
      p.t += dt;
      const homing = p.fx === 'rocket' || p.fx === 'plasma' || p.fx === 'missile' || p.fx === 'laser';
      if (homing && p.target) {
        const t = this.entity(p.target);
        if (t && !t.dead && !(t.kind === 'unit' && t.container)) {
          p.tx = t.x;
          p.ty = t.y;
        }
      }
      const k = Math.min(1, p.t / p.dur);
      p.x = p.sx + (p.tx - p.sx) * k;
      p.y = p.sy + (p.ty - p.sy) * k;
      if (k < 1) {
        keep.push(p);
        continue;
      }
      // impact
      const t = p.target ? this.entity(p.target) : undefined;
      if (t && t.kind === 'unit' && t.key === 'tank' && p.dmg === 'ap' && !p.jammed && this.time >= t.apsReady && this.has(t.owner, 'aps')) {
        // active protection: the incoming round is shot down just short of the tank
        t.apsReady = this.time + UPGRADE.aps.cooldown;
        const back = Math.atan2(p.sy - t.y, p.sx - t.x);
        if (this.collectFx) {
          this.fx.push({ k: 'impact', fx: 'missile', x: t.x + Math.cos(back) * 0.9, y: t.y + Math.sin(back) * 0.9, size: 0.4, air: false });
          this.fx.push({ k: 'text', x: t.x, y: t.y - 1, text: 'APS', color: '#9fe8ff', owner: t.owner });
        }
        continue;
      }
      if (this.collectFx) this.fx.push({ k: 'impact', fx: p.fx, x: p.tx, y: p.ty, size: p.splash ? p.splash : 0.4, air: p.toAir });
      if (p.splash > 0) {
        if (t && !t.dead && dist(t.x, t.y, p.tx, p.ty) < (t.kind === 'building' ? t.radius + 0.5 : 0.8)) this.damage(t, p.damage, p.dmg, p.owner, p.src, p.sx, p.sy);
        this.splash(p.tx, p.ty, p.splash, p.damage, p.dmg, p.owner, p.src, p.sx, p.sy, t ?? null);
      } else if (t && !t.dead) {
        this.damage(t, p.damage, p.dmg, p.owner, p.src, p.sx, p.sy);
      }
    }
    this.projectiles = keep;
  }

  private splash(x: number, y: number, r: number, damage: number, dmg: DmgType, owner: number, src: number, sx: number, sy: number, skip: Entity | null): void {
    this.forUnitsNear(x, y, r + 0.6, (u, d) => {
      if (u === skip || !this.hostile(owner, u.owner) || u.air) return;
      const f = 1 - 0.5 * clamp(d / (r + 0.6), 0, 1);
      this.damage(u, damage * f * 0.75, dmg, owner, src, sx, sy);
    });
    for (const b of this.buildings) {
      if (b.dead || b === skip || !this.hostile(owner, b.owner)) continue;
      const d = distToRect(x, y, b.tx, b.ty, b.w, b.h);
      if (d > r) continue;
      this.damage(b, damage * (1 - 0.5 * (d / r)) * 0.6, dmg, owner, src, sx, sy);
    }
  }

  armorOf(e: Entity): Armor {
    return e.kind === 'unit' ? e.def.armor : 'bldg';
  }

  damage(t: Entity, amount: number, dmg: DmgType | 'super', owner: number, src: number, sx: number, sy: number): void {
    if (t.dead) return;
    const mult = dmg === 'super' ? 1 : damageMult(dmg, this.armorOf(t));
    if (mult <= 0) return;
    let d = amount * mult;
    if (t.kind === 'building' && t.garrison && dmg !== 'super') {
      // the emplacement soaks most of it
      const g = t.garrison;
      this.hurtUnit(g, d * 0.3, owner);
      if (g.dead) t.garrison = null;
      d *= 0.6;
    }
    t.hp -= d;
    t.lastHurtT = this.time;
    if (t.owner === NEUTRAL && owner !== NEUTRAL && owner >= 0) {
      t.hostileTo[owner] = this.time + 10;
      this.neutralHook?.provoke(owner, t.camp, d, sx, sy);
    }
    if (t.owner < SLOTS && owner !== t.owner) {
      if (t.kind === 'building') {
        const key = t.key === 'hq' ? 'hq-attack' : 'base-attack';
        this.alert(t.owner, key, t.key === 'hq' ? 'Your HQ is under attack!' : `${t.def.name} under attack`, t.x, t.y, 'attack', t.key === 'hq' ? 12 : 18);
      } else if (t.def.role === 'gatherer' || t.def.role === 'builder') {
        this.alert(t.owner, 'eco-attack', `${t.def.name} under attack`, t.x, t.y, 'attack', 20);
      } else {
        this.alert(t.owner, 'army-attack-' + Math.floor(t.x / 16) + ',' + Math.floor(t.y / 16), 'Units under attack', t.x, t.y, 'attack', 25);
      }
    }
    if (t.kind === 'unit') {
      const before = t.alive;
      if (t.hp <= 0) this.kill(t, owner);
      else if (t.def.members && t.alive < before && this.collectFx) this.fx.push({ k: 'death', x: t.x, y: t.y, faction: t.faction, owner: t.owner });
    } else if (t.hp <= 0) this.kill(t, owner);
  }

  private hurtUnit(u: Unit, d: number, owner: number): void {
    u.hp -= d;
    u.lastHurtT = this.time;
    if (u.hp <= 0) this.kill(u, owner);
  }

  kill(e: Entity, killer: number): void {
    if (e.dead) return;
    e.dead = true;
    e.hp = 0;
    const victim = this.players[e.owner];
    if (killer >= 0 && killer !== e.owner) this.players[killer].stats.kills++;
    if (e.kind === 'unit') {
      victim.stats.unitsLost++;
      if (e.loadingPile) this.releasePile(e);
      if (this.collectFx) {
        if (e.def.members) this.fx.push({ k: 'death', x: e.x, y: e.y, faction: e.faction, owner: e.owner });
        else this.fx.push({ k: 'explode', x: e.x, y: e.y, size: e.def.armor === 'heavy' ? 1.6 : 1.1, air: e.air });
      }
      // passengers bail out of a wrecked vehicle, hurt; nobody survives a downed aircraft
      if (e.passengers.length) {
        const ps = [...e.passengers];
        if (e.air) {
          e.passengers = [];
          for (const p of ps) {
            p.container = 0;
            p.x = e.x;
            p.y = e.y;
            this.kill(p, killer);
          }
        } else {
          this.unload(e);
          for (const p of ps) this.hurtUnit(p, p.maxHp * 0.5, killer);
        }
      }
      if (e.container) {
        const c = this.entity(e.container);
        if (c && c.kind === 'unit') c.passengers = c.passengers.filter((p) => p !== e);
        if (c && c.kind === 'building' && c.garrison === e) c.garrison = null;
      }
    } else {
      victim.stats.structuresLost++;
      if (killer >= 0 && killer !== e.owner) this.players[killer].stats.structuresDestroyed++;
      this.map.clearOcc(e.tx, e.ty, e.w, e.h, e.id);
      if (this.collectFx) this.fx.push({ k: 'explode', x: e.x, y: e.y, size: Math.max(e.w, e.h) * 1.1, air: false });
      if (e.garrison) this.unload(e);
      // refund nothing; production is lost
      if (e.key === 'hq') this.defeat(e.owner);
      if (e.key === 'fortress') {
        const camp = this.camp(e.camp);
        if (camp) camp.zone.active = false;
        this.paths.clear();
        if (killer >= 0 && killer < SLOTS) {
          this.players[killer].supplies += FORTRESS_BOUNTY;
          this.players[killer].stats.gathered += FORTRESS_BOUNTY;
          this.alert(killer, 'fortress-' + e.id, `Marauder stronghold destroyed! +${FORTRESS_BOUNTY} supplies. Its caches are yours to take.`, e.x, e.y, 'done', 0);
          for (const o of this.activePlayers) if (o.id !== killer) this.alert(o.id, 'fortress-other-' + e.id, `${this.players[killer].name} destroyed a Marauder stronghold`, e.x, e.y, 'info', 0);
        }
        this.neutralHook?.onFortressDestroyed(e.camp);
      }
      if (e.owner < SLOTS && e.key !== 'hq') this.alert(e.owner, 'lost-' + e.id, `${e.def.name} destroyed`, e.x, e.y, 'attack', 0);
    }
  }

  /** A player is out when their HQ falls; everything they own goes with it. */
  defeat(owner: number): void {
    const pl = this.players[owner];
    if (!pl || !pl.active || pl.defeated) return;
    pl.defeated = true;
    for (const u of this.units) if (u.owner === owner && !u.dead) this.kill(u, -1);
    for (const b of this.buildings) if (b.owner === owner && !b.dead) this.kill(b, -1);
    for (const o of this.activePlayers) if (o.id !== owner) this.alert(o.id, 'defeated-' + owner, `${pl.name} has been eliminated`, pl.hq?.x ?? 48, pl.hq?.y ?? 48, this.hostile(o.id, owner) ? 'done' : 'warn', 0);
    const teams = new Set(this.activePlayers.filter((p) => !p.defeated).map((p) => p.team));
    if (teams.size <= 1) {
      this.over = true;
      this.winnerTeam = teams.size === 1 ? [...teams][0] : -1;
      this.winner = this.activePlayers.find((p) => p.team === this.winnerTeam && !p.defeated)?.id ?? -1;
    }
  }

  /** Did this player's team win? */
  won(p: number): boolean {
    return this.over && this.players[p].team === this.winnerTeam;
  }

  private updateStrikes(dt: number): void {
    for (const s of this.strikes) {
      s.t -= dt;
      if (s.t > 0) continue;
      if (this.collectFx) this.fx.push({ k: 'super', x: s.x, y: s.y, faction: s.faction, radius: s.radius, phase: 'hit' });
      const hit = (e: Entity, d: number) => {
        const f = d < s.radius * 0.4 ? 1 : 1 - 0.7 * clamp((d - s.radius * 0.4) / (s.radius * 0.6), 0, 1);
        this.damage(e, s.damage * f, 'super', s.owner, -1, s.x, s.y);
      };
      this.forUnitsNear(s.x, s.y, s.radius, (u, d) => hit(u, d));
      for (const b of this.buildings) {
        if (b.dead) continue;
        const d = distToRect(s.x, s.y, b.tx, b.ty, b.w, b.h);
        if (d <= s.radius) hit(b, d);
      }
    }
    this.strikes = this.strikes.filter((s) => s.t > 0);
  }

  // ---------------------------------------------------------------- fog of war

  updateFog(team: number): void {
    const members = this.players.filter((p) => p.team === team);
    if (!members.length) return;
    const vision = members[0].vision;
    const vis = vision.vis;
    vis.fill(0);
    const map = this.map;
    const isMember = (o: number) => this.players[o].team === team;
    for (const u of this.units) {
      if (u.dead || u.container || !isMember(u.owner)) continue;
      castVision(map, vis, u.x, u.y, this.sightOf(u), u.air);
    }
    for (const b of this.buildings) {
      if (b.dead || !isMember(b.owner)) continue;
      castVision(map, vis, b.x, b.y, b.built ? b.def.sight : 4, false);
      // also see from the corners so large buildings don't hide behind their own edge
      if (b.w >= 3) {
        castVision(map, vis, b.tx + 0.5, b.ty + 0.5, 3, false);
        castVision(map, vis, b.tx + b.w - 0.5, b.ty + b.h - 0.5, 3, false);
      }
    }
    for (const p of members) for (const r of p.recon) castVision(map, vis, r.x, r.y, RECON.radius, true);
    const ex = vision.explored;
    for (let i = 0; i < vis.length; i++) if (vis[i]) ex[i] = 1;
    // remember enemy buildings we've seen
    const W = map.w;
    for (const b of this.buildings) {
      if (b.dead || isMember(b.owner)) continue;
      let seen = false;
      for (let y = b.ty; y < b.ty + b.h && !seen; y++) for (let x = b.tx; x < b.tx + b.w; x++) if (vis[y * W + x]) seen = true;
      if (seen) vision.ghosts.set(b.id, { id: b.id, key: b.key, faction: b.faction, owner: b.owner, tx: b.tx, ty: b.ty, w: b.w, h: b.h, built: b.built, hpFrac: b.hp / b.maxHp });
    }
    for (const [id, g] of vision.ghosts) {
      const b = this.byId.get(id);
      if (b && !b.dead) continue;
      // forget it once we can see the empty ground
      if (vis[(g.ty + (g.h >> 1)) * W + g.tx + (g.w >> 1)]) vision.ghosts.delete(id);
    }
  }
}
