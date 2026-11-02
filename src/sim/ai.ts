// Computer opponent for skirmish games. It plays by the same rules as you:
// same fog of war, same costs, same build times. Difficulty changes how
// fast it thinks, how efficiently it gathers and how cleverly it builds.

import { dist, Rng } from '../core/math';
import { FACTIONS, unitDef, type BuildingKey, type ResearchKey, type UnitKey } from '../data/defs';
import type { Building, Pile, Unit } from './entities';
import { NEUTRAL, type Controller, type Difficulty, type Ghost, type Player, type World } from './world';

interface Params {
  interval: number;
  gatherMul: number;
  threshold: number;
  /** Earliest time (seconds) for the first attack wave. */
  firstWave: number;
  queue: number;
  builders: number;
  trucksPerPile: number;
  counters: boolean;
  defenses: boolean;
  raidMarauders: boolean;
}

const PARAMS: Record<Difficulty, Params> = {
  easy: { interval: 2.5, gatherMul: 0.8, threshold: 3000, firstWave: 480, queue: 1, builders: 2, trucksPerPile: 2, counters: false, defenses: false, raidMarauders: false },
  normal: { interval: 1.2, gatherMul: 1.0, threshold: 2400, firstWave: 360, queue: 1, builders: 2, trucksPerPile: 3, counters: true, defenses: true, raidMarauders: true },
  hard: { interval: 0.6, gatherMul: 1.25, threshold: 2000, firstWave: 270, queue: 2, builders: 3, trucksPerPile: 3, counters: true, defenses: true, raidMarauders: true },
};

interface Step {
  label: string;
  key?: BuildingKey;
  research?: ResearchKey;
  n?: number;
  want: () => boolean;
  place?: () => { x: number; y: number } | null;
  /** Economy and tech: saved for even while the army is small. */
  eco?: boolean;
}

export class SkirmishAI implements Controller {
  private t = 1;
  private readonly prm: Params;
  private rng: Rng;
  state: 'gather' | 'attack' | 'defend' | 'raid' = 'gather';
  private threshold: number;
  private launchStrength = 0;
  private lastOrderT = -99;
  private lastThreatT = -99;
  private seen = { inf: 0, veh: 0, air: 0 };
  private scoutIdx = 0;
  private raidId = 0;
  private steps: Step[];
  waves = 0;

  constructor(
    private w: World,
    readonly p: number,
    readonly diff: Difficulty,
  ) {
    this.prm = PARAMS[diff];
    this.threshold = this.prm.threshold;
    this.rng = new Rng(1234 + p * 77);
    w.players[p].gatherMul = this.prm.gatherMul;
    this.steps = this.makePlan();
  }

  private get me() {
    return this.w.players[this.p];
  }
  /** Opponents still in the game. */
  private enemies(): Player[] {
    return this.w.activePlayers.filter((o) => !o.defeated && this.w.hostile(this.p, o.id));
  }

  private isEnemy(owner: number): boolean {
    return owner !== NEUTRAL && owner >= 0 && this.w.hostile(this.p, owner) && !this.w.players[owner].defeated;
  }

  /** The enemy we're currently going after: the one whose base is closest. */
  private focus(): Player | null {
    const hq = this.hq;
    if (!hq) return null;
    let best: Player | null = null;
    let bd = Infinity;
    for (const e of this.enemies()) {
      const s = this.w.map.starts[e.id].hq;
      const d = dist(s.x, s.y, hq.x, hq.y);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private enemyGhosts(): Ghost[] {
    return [...this.me.ghosts.values()].filter((g) => this.isEnemy(g.owner));
  }
  private get hq(): Building | null {
    const h = this.me.hq;
    return h && !h.dead ? h : null;
  }
  private get rally() {
    return this.w.map.starts[this.p].rally;
  }

  update(dt: number): void {
    this.t -= dt;
    if (this.t > 0) return;
    this.t = this.prm.interval;
    if (this.w.over || this.me.defeated || !this.hq) return;
    this.observe();
    const reserve = this.economy();
    this.produceArmy(reserve);
    this.commandArmy();
    this.useAirAndPowers();
    this.scout();
  }

  // ---------------------------------------------------------------- knowledge

  private observe(): void {
    const s = { inf: 0, veh: 0, air: 0 };
    for (const u of this.w.units) {
      if (!this.isEnemy(u.owner) || u.dead || u.container || !this.w.visibleTo(u, this.p)) continue;
      if (u.def.armor === 'inf') s.inf++;
      else if (u.def.armor === 'air') s.air++;
      else if (u.def.weapons.length) s.veh++;
    }
    this.seen.inf = this.seen.inf * 0.95 + s.inf * 0.3;
    this.seen.veh = this.seen.veh * 0.95 + s.veh * 0.3;
    this.seen.air = this.seen.air * 0.95 + s.air * 0.3;
  }

  private mine(): Unit[] {
    return this.w.units.filter((u) => u.owner === this.p && !u.dead);
  }

  private army(): Unit[] {
    return this.mine().filter((u) => !u.container && u.def.weapons.length > 0 && !u.def.bomber && (u.def.role === 'infantry' || u.def.role === 'vehicle' || u.def.role === 'air'));
  }

  private strength(units: Unit[]): number {
    return units.reduce((s, u) => s + u.def.cost * (u.hp / u.maxHp), 0);
  }

  private count(key: BuildingKey): number {
    return this.w.countBuildings(this.p, key);
  }

  private queuedOrBuilt(key: UnitKey): number {
    let n = this.mine().filter((u) => u.key === key).length;
    for (const b of this.w.buildingsOf(this.p)) n += b.queue.filter((q) => q.key === key).length;
    return n;
  }

  private researching(key: ResearchKey): boolean {
    return this.w.buildingsOf(this.p).some((b) => b.queue.some((q) => q.key === key));
  }

  // ---------------------------------------------------------------- economy & building

  private makePlan(): Step[] {
    const w = this.w;
    const d = this.prm;
    const t = () => w.time;
    const tier = () => this.me.tier;
    const base = () => this.baseSpot();
    const B = (label: string, key: BuildingKey, n: number, want: () => boolean, place: () => { x: number; y: number } | null): Step => ({
      label,
      key,
      n,
      want,
      place,
      eco: key === 'depot' || key === 'dropzone',
    });
    const R = (key: ResearchKey, want: () => boolean): Step => ({ label: key, research: key, want, eco: key === 'tier2' || key === 'tier3' });
    return [
      B('depot', 'depot', 1, () => true, () => this.depotSpot(this.mainPile())),
      B('barracks', 'barracks', 1, () => true, base),
      B('defense', 'defense', 1, () => d.defenses && t() > 150, base),
      R('tier2', () => this.count('barracks') > 0 && this.count('depot') > 0 && t() > 120),
      B('expand', 'depot', 2, () => t() > 300 || this.mainLeft() < 0.6, () => this.depotSpot(this.expansionPile())),
      B('factory', 'factory', 1, () => tier() >= 2, base),
      B('bunker', 'bunker', 1, () => d.defenses && t() > 240, () => this.rampSpot(3)),
      B('dropzone', 'dropzone', 1, () => tier() >= 2 && t() > 300, base),
      R('medic', () => tier() >= 2 && t() > 420),
      B('barracks2', 'barracks', 2, () => this.diff === 'hard' && tier() >= 2, base),
      R('tier3', () => this.count('factory') > 0 && t() > 480),
      B('airbase', 'airbase', 1, () => tier() >= 3, base),
      B('sam', 'sam', 1, () => d.defenses && this.seen.air > 0.5, () => this.nearSpot(this.hq!.x, this.hq!.y, 3, 10)),
      B('arty', 'arty', 1, () => d.defenses && tier() >= 2 && t() > 600, () => this.rampSpot(5)),
      B('dropzone2', 'dropzone', 2, () => tier() >= 3, base),
      B('expand2', 'depot', 3, () => t() > 600 || this.activeSupply() < 4000, () => this.depotSpot(this.expansionPile())),
      R('tier4', () => this.count('airbase') > 0 && t() > 780),
      B('super', 'super', 1, () => tier() >= 4, base),
      B('factory2', 'factory', 2, () => this.diff !== 'easy' && tier() >= 3, base),
      B('sam2', 'sam', 2, () => d.defenses && this.seen.air > 3, () => this.nearSpot(this.hq!.x, this.hq!.y, 3, 12)),
      B('dropzone3', 'dropzone', 3, () => tier() >= 4, base),
      B('expand3', 'depot', 4, () => this.activeSupply() < 3000 && t() > 900, () => this.depotSpot(this.expansionPile())),
    ];
  }

  private stepDone(s: Step): boolean {
    if (s.key) return this.count(s.key) >= (s.n ?? 1);
    if (s.research) return this.me.researched.has(s.research) || this.researching(s.research);
    return true;
  }

  private pendingEco = false;

  /** Works through the build plan. Returns supplies to hold back for the next step. */
  private runPlan(): number {
    this.pendingEco = false;
    const w = this.w;
    for (const s of this.steps) {
      if (this.stepDone(s) || !s.want()) continue;
      if (s.key) {
        if (w.requirement(this.p, s.key)) continue;
        const cost = FACTIONS[this.me.faction].buildings[s.key]!.cost;
        if (this.me.supplies < cost) {
          this.pendingEco = !!s.eco;
          return cost;
        }
        this.pendingKey = s.key;
        const spot = s.place?.();
        if (spot && this.construct(s.key, spot.x, spot.y)) return 0;
        continue;
      }
      if (s.research) {
        const at = s.research === 'medic' ? w.buildingsOf(this.p).find((b) => b.key === 'barracks' && b.built) : this.hq;
        if (!at) continue;
        const why = w.researchBlocker(at, s.research);
        const cost = FACTIONS[this.me.faction].research[s.research]!.cost;
        if (why === 'Not enough supplies') {
          this.pendingEco = !!s.eco;
          return cost;
        }
        if (why) continue;
        w.queueResearch(at, s.research);
        return 0;
      }
    }
    return 0;
  }

  /** Runs the build plan and the worker economy. Returns supplies to hold back. */
  private economy(): number {
    const w = this.w;
    const hq = this.hq!;
    const units = this.mine();
    const builders = units.filter((u) => u.def.role === 'builder');
    const trucks = units.filter((u) => u.def.role === 'gatherer');

    // builders
    const wantB = this.me.tier >= 2 ? this.prm.builders + (this.diff === 'easy' ? 0 : 1) : this.prm.builders;
    const qb = hq.queue.filter((q) => q.key === 'builder').length;
    if (builders.length + qb < wantB && hq.queue.length === 0) w.queueUnit(hq, 'builder');

    // idle builders help finish construction or repair
    for (const b of builders) {
      if (b.order.type !== 'idle') continue;
      const job = w.buildings.find((x) => x.owner === this.p && !x.dead && (!x.built || x.hp < x.maxHp * 0.9));
      if (job) w.cmdBuild([b], job);
    }

    // trucks
    for (const tr of trucks) {
      if (tr.order.type === 'idle') {
        const pile = w.findPileFor(tr);
        if (pile) w.cmdGather([tr], pile);
      }
    }
    // trucks: a few per cache that has a drop-off next to it, and always at least two while any cache is left
    const depots = w.buildingsOf(this.p).filter((b) => b.key === 'depot' && b.built);
    const drops = w.buildingsOf(this.p).filter((b) => b.def.dropoff && b.built);
    const worked = w.piles.filter((p) => p.amount > 300 && drops.some((d) => dist(p.x, p.y, d.x, d.y) < 11));
    const anyLeft = w.piles.some((p) => p.amount > 0 && !w.inZone(p.x, p.y, 1));
    const wantT = Math.min(14, Math.max(anyLeft ? 2 : 0, worked.length * this.prm.trucksPerPile));
    const queuedT = depots.reduce((n, d) => n + d.queue.filter((q) => q.key === 'truck').length, 0);
    if (depots.length && trucks.length + queuedT < wantT) {
      const pick = depots
        .filter((d) => d.queue.length === 0)
        .sort((a, b) => {
          const pa = w.nearestPile(a.x, a.y);
          const pb = w.nearestPile(b.x, b.y);
          return (pa ? dist(pa.x, pa.y, a.x, a.y) : 99) - (pb ? dist(pb.x, pb.y, b.x, b.y) : 99);
        })[0];
      if (pick) w.queueUnit(pick, 'truck');
    }
    return this.runPlan();
  }

  private construct(key: BuildingKey, tx: number, ty: number): boolean {
    const builders = this.mine().filter((u) => u.def.role === 'builder');
    if (!builders.length) return false;
    const busyBuilding = (u: Unit) => {
      if (u.order.type !== 'build') return false;
      const e = this.w.entity(u.order.target);
      return !!e && e.kind === 'building' && !e.built;
    };
    const free = builders.filter((b) => b.order.type === 'idle');
    const pool = free.length ? free : builders.filter((b) => !busyBuilding(b));
    const pick = (pool.length ? pool : builders).sort((a, b) => dist(a.x, a.y, tx, ty) - dist(b.x, b.y, tx, ty))[0];
    const res = this.w.startConstruction(this.p, key, tx, ty, [pick]);
    return typeof res !== 'string';
  }

  private mainPile(): Pile | null {
    const hq = this.hq!;
    return this.w.nearestPile(hq.x, hq.y);
  }

  private mainLeft(): number {
    const p = this.w.piles.find((x) => dist(x.x, x.y, this.hq!.x, this.hq!.y) < 12);
    return p ? p.amount / p.max : 0;
  }

  private activeSupply(): number {
    let s = 0;
    for (const d of this.w.buildingsOf(this.p).filter((b) => b.def.dropoff)) {
      for (const p of this.w.piles) if (dist(p.x, p.y, d.x, d.y) < 10) s += p.amount;
    }
    return s;
  }

  private expansionPile(): Pile | null {
    const w = this.w;
    const hq = this.hq!;
    const ehqs = this.enemies().map((e) => w.map.starts[e.id].hq);
    const drops = w.buildingsOf(this.p).filter((b) => b.def.dropoff);
    let best: Pile | null = null;
    let bs = Infinity;
    for (const p of w.piles) {
      if (p.amount < 1200 || w.inZone(p.x, p.y, 2)) continue;
      if (ehqs.some((e) => dist(p.x, p.y, e.x + 2, e.y + 2) < 26)) continue;
      if (drops.some((d) => dist(d.x, d.y, p.x, p.y) < 10)) continue;
      const s = dist(p.x, p.y, hq.x, hq.y);
      if (s < bs) {
        bs = s;
        best = p;
      }
    }
    return best;
  }

  private depotSpot(p: Pile | null): { x: number; y: number } | null {
    if (!p) return null;
    const hq = this.hq!;
    let best: { x: number; y: number } | null = null;
    let bs = Infinity;
    for (let dy = -7; dy <= 6; dy++)
      for (let dx = -7; dx <= 6; dx++) {
        const tx = p.tx + dx;
        const ty = p.ty + dy;
        const cx = tx + 1.5;
        const cy = ty + 1.5;
        const d = dist(cx, cy, p.x, p.y);
        if (d < 3.4 || d > 6.5) continue;
        if (!this.w.canPlace(this.p, 'depot', tx, ty).ok) continue;
        const s = d + dist(cx, cy, hq.x, hq.y) * 0.15;
        if (s < bs) {
          bs = s;
          best = { x: tx, y: ty };
        }
      }
    return best;
  }

  private baseSpot(): { x: number; y: number } | null {
    const hq = this.hq!;
    return this.nearSpot(hq.x, hq.y, 4, 15);
  }

  /** Spot just inside the top of our ramp, for defences. */
  private rampSpot(inset: number): { x: number; y: number } | null {
    const ramp = this.w.map.starts[this.p].ramps[0];
    const hq = this.hq!;
    const dx = hq.x - ramp.x;
    const dy = hq.y - ramp.y;
    const l = Math.hypot(dx, dy) || 1;
    return this.nearSpot(ramp.x + (dx / l) * inset, ramp.y + (dy / l) * inset, 0, 6);
  }

  private pendingKey: BuildingKey = 'barracks';

  /** First valid placement for the building the plan is currently trying, spiralling out from a point. */
  private nearSpot(cx: number, cy: number, minR: number, maxR: number): { x: number; y: number } | null {
    const key = this.pendingKey;
    const def = FACTIONS[this.me.faction].buildings[key]!;
    const w = def.w;
    const h = def.h;
    const start = this.rng.next() * Math.PI * 2;
    for (let r = minR; r <= maxR; r++) {
      const n = Math.max(8, Math.round(r * 6));
      for (let k = 0; k < n; k++) {
        const a = start + (k / n) * Math.PI * 2;
        const tx = Math.round(cx + Math.cos(a) * r - w / 2);
        const ty = Math.round(cy + Math.sin(a) * r - h / 2);
        if (this.w.canPlace(this.p, key, tx, ty).ok) return { x: tx, y: ty };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- army production

  private produceArmy(reserve: number): void {
    const w = this.w;
    // keep a minimum army before saving up for tech
    const desired = Math.min(5000, 800 + w.time * 5);
    const weak = this.strength(this.army()) < desired;
    const underAttack = this.state === 'defend';
    let budget = this.me.supplies - (underAttack || (weak && !this.pendingEco) ? 0 : reserve);
    const prod = w.buildingsOf(this.p).filter((b) => b.built && (b.key === 'barracks' || b.key === 'factory' || b.key === 'airbase'));
    for (const b of prod) {
      if (b.queue.length >= this.prm.queue) continue;
      const key = this.chooseUnit(b);
      if (!key) continue;
      const cost = unitDef(this.me.faction, key).cost;
      if (cost > budget) continue;
      if (w.queueUnit(b, key) === '') budget -= cost;
    }
  }

  private chooseUnit(b: Building): UnitKey | null {
    const s = this.prm.counters ? this.seen : { inf: 1, veh: 1, air: 0 };
    const total = s.inf + s.veh + s.air + 0.01;
    const fi = s.inf / total;
    const fv = s.veh / total;
    const fa = s.air / total;
    let opts: [UnitKey, number][] = [];
    if (b.key === 'barracks') {
      opts = [
        ['rifle', 4 + fa * 3],
        ['sniper', 1.5 + fi * 5],
        ['rocket', 1.5 + fv * 6 + fa * 5],
      ];
      // no vehicles yet: lean on rifles
      if (this.me.tier < 2) opts[0][1] += 2;
    } else if (b.key === 'factory') {
      const scouts = this.queuedOrBuilt('scout');
      if (scouts === 0 && this.diff !== 'easy') return 'scout';
      opts = [
        ['light', 2 + fi * 3],
        ['tank', 3 + fv * 2 + fi * 2],
      ];
    } else if (b.key === 'airbase') {
      const bombers = this.queuedOrBuilt('bomber');
      opts = [
        ['gunship', 3 + fv * 4],
        ['bomber', bombers < 2 ? 2 : 0.5],
      ];
    }
    const sum = opts.reduce((a, o) => a + o[1], 0);
    let r = this.rng.next() * sum;
    for (const [k, wgt] of opts) {
      r -= wgt;
      if (r <= 0) return k;
    }
    return opts.length ? opts[0][0] : null;
  }

  // ---------------------------------------------------------------- army control

  private threat(): { x: number; y: number; n: number } | null {
    const w = this.w;
    const hq = this.hq!;
    // our buildings, plus nearby allied ones (help a human team-mate defend)
    const guard = w.buildings.filter((b) => !b.dead && !w.hostile(this.p, b.owner) && b.owner !== NEUTRAL && (b.owner === this.p || dist(b.x, b.y, hq.x, hq.y) < 40));
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const u of w.units) {
      if (u.dead || u.container || !w.hostile(this.p, u.owner) || !w.visibleTo(u, this.p)) continue;
      if (u.owner === NEUTRAL && u.raidUntil < w.time) continue;
      if (u.def.weapons.length === 0 && !u.def.bomber) continue;
      if (!guard.some((b) => dist(b.x, b.y, u.x, u.y) < 12)) continue;
      sx += u.x;
      sy += u.y;
      n++;
    }
    return n ? { x: sx / n, y: sy / n, n } : null;
  }

  /** Nearest Marauder stronghold worth clearing (it sits on supplies). */
  private campTarget(): { id: number; x: number; y: number } | null {
    const w = this.w;
    const hq = this.hq!;
    let best: { id: number; x: number; y: number } | null = null;
    let bd = 60;
    for (const b of w.buildings) {
      if (b.dead || b.key !== 'fortress') continue;
      const d = dist(b.x, b.y, hq.x, hq.y);
      if (d < bd) {
        bd = d;
        best = { id: b.id, x: b.x, y: b.y };
      }
    }
    return best;
  }

  private commandArmy(): void {
    const w = this.w;
    const army = this.army().filter((u) => u.def.role !== 'vehicle' || u.key !== 'scout');
    const str = this.strength(army);
    const th = this.threat();
    if (th) {
      this.lastThreatT = w.time;
      if (this.state !== 'defend') this.state = 'defend';
      const defenders = army.filter((u) => u.order.type === 'idle' || (u.order.type === 'move' && dist(u.order.gx, u.order.gy, th.x, th.y) > 6));
      if (defenders.length) w.cmdMove(defenders, th.x, th.y, true);
      this.garrison();
      return;
    }
    if (this.state === 'defend' && w.time - this.lastThreatT > 8) {
      this.state = 'gather';
      w.cmdMove(army, this.rally.x, this.rally.y, true);
    }

    if (this.state === 'gather') {
      const strays = army.filter((u) => u.order.type === 'idle' && dist(u.x, u.y, this.rally.x, this.rally.y) > 7);
      if (strays.length) w.cmdMove(strays, this.rally.x, this.rally.y, true);
      this.garrison();
      const camp = this.campTarget();
      if (camp && this.prm.raidMarauders && str > 3600 && this.me.tier >= 2 && w.time > 540 && this.waves >= 1 && this.rng.next() < 0.5) {
        this.state = 'raid';
        this.raidId = camp.id;
        this.launchStrength = str;
        w.cmdMove(army, camp.x, camp.y, true);
        this.lastOrderT = w.time;
        return;
      }
      if (str >= this.threshold && w.time >= this.prm.firstWave) {
        this.state = 'attack';
        this.waves++;
        this.launchStrength = str;
        this.lastOrderT = -99;
      }
    }

    if (this.state === 'raid') {
      const fortress = w.entity(this.raidId);
      if (!fortress || fortress.dead || str < this.launchStrength * 0.4) {
        this.state = 'gather';
        w.cmdMove(army, this.rally.x, this.rally.y, true);
        return;
      }
      if (w.time - this.lastOrderT > 6) {
        this.lastOrderT = w.time;
        const idle = army.filter((u) => u.order.type === 'idle');
        if (idle.length) w.cmdAttack(idle, fortress);
      }
      return;
    }

    if (this.state === 'attack') {
      if (str < this.launchStrength * 0.35) {
        this.state = 'gather';
        this.threshold = Math.min(this.threshold * 1.2, 6000);
        w.cmdMove(army, this.rally.x, this.rally.y, false);
        return;
      }
      if (w.time - this.lastOrderT > 6) {
        this.lastOrderT = w.time;
        const c = this.centroid(army);
        const target = this.pickTarget(c.x, c.y);
        // only redirect units that aren't already busy fighting
        const free = army.filter((u) => u.order.type === 'idle' || (u.order.type === 'move' && dist(u.order.gx, u.order.gy, target.x, target.y) > 4));
        if (free.length) w.cmdMove(free, target.x, target.y, true);
      }
      this.threshold = Math.max(this.threshold, this.prm.threshold + this.waves * 400);
    }
  }

  private garrison(): void {
    const w = this.w;
    for (const b of w.buildingsOf(this.p)) {
      if (b.key !== 'bunker' || !b.built || b.garrison) continue;
      const inf = this.army().filter((u) => u.def.infantry && u.key !== 'sniper' && u.order.type === 'idle');
      if (!inf.length) continue;
      inf.sort((a, c) => dist(a.x, a.y, b.x, b.y) - dist(c.x, c.y, b.x, b.y));
      if (dist(inf[0].x, inf[0].y, b.x, b.y) < 25) w.cmdEnter([inf[0]], b);
    }
  }

  private centroid(units: Unit[]): { x: number; y: number } {
    if (!units.length) return this.rally;
    let x = 0;
    let y = 0;
    for (const u of units) {
      x += u.x;
      y += u.y;
    }
    return { x: x / units.length, y: y / units.length };
  }

  /** Nearest enemy structure we know about; otherwise the focus enemy's HQ start spot. */
  private pickTarget(x: number, y: number): { x: number; y: number } {
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (const g of this.enemyGhosts()) {
      const gx = g.tx + g.w / 2;
      const gy = g.ty + g.h / 2;
      const d = dist(x, y, gx, gy);
      if (d < bd) {
        bd = d;
        best = { x: gx, y: gy };
      }
    }
    if (best) return best;
    const f = this.focus();
    const s = f ? this.w.map.starts[f.id].hq : this.rally;
    return { x: s.x + 2, y: s.y + 2 };
  }

  // ---------------------------------------------------------------- air, powers, scouting

  private useAirAndPowers(): void {
    const w = this.w;
    // bombers hit structures, avoiding known anti-air
    const ghosts = this.enemyGhosts();
    const sams = ghosts.filter((g) => g.key === 'sam');
    const targets = ghosts.filter((g) => !sams.some((s) => dist(s.tx, s.ty, g.tx, g.ty) < 11));
    for (const u of this.mine()) {
      if (!u.def.bomber || u.ammo <= 0 || u.order.type !== 'idle') continue;
      const g = targets[Math.floor(this.rng.next() * targets.length)];
      if (g) {
        const e = w.entity(g.id);
        if (e && !e.dead) w.cmdAttack([u], e);
        else w.cmdAttackGround([u], g.tx + g.w / 2, g.ty + g.h / 2);
      }
    }
    // superweapon
    const sw = w.superweapon(this.p);
    if (sw && sw.charge <= 0) {
      let best: { x: number; y: number } | null = null;
      let bn = 0;
      const gs = ghosts;
      for (const g of gs) {
        const gx = g.tx + g.w / 2;
        const gy = g.ty + g.h / 2;
        let n = 0;
        for (const o of gs) if (dist(gx, gy, o.tx + o.w / 2, o.ty + o.h / 2) < 5) n += o.key === 'hq' ? 3 : 1;
        if (n > bn) {
          bn = n;
          best = { x: gx, y: gy };
        }
      }
      const f = this.focus();
      if (!best && f) {
        const s = w.map.starts[f.id].hq;
        if (w.tileExplored(this.p, s.x + 2, s.y + 2)) best = { x: s.x + 2, y: s.y + 2 };
      }
      if (best) w.fireSuperweapon(this.p, best.x, best.y);
    }
  }

  private scout(): void {
    const w = this.w;
    const sc = this.mine().find((u) => u.key === 'scout');
    if (!sc || sc.order.type !== 'idle') return;
    const f = this.focus();
    const pts: { x: number; y: number }[] = [
      ...this.enemies().map((e) => w.map.starts[e.id].rally),
      ...w.piles.filter((p) => !w.inZone(p.x, p.y, 2)).map((p) => ({ x: p.x, y: p.y + 2.5 })),
    ];
    if (f) pts.push(w.map.starts[f.id].rally);
    const pt = pts[this.scoutIdx++ % pts.length];
    w.cmdMove([sc], pt.x, pt.y);
    if (sc.abilityCd <= 0 && this.scoutIdx % 3 === 0) w.cmdAbility(this.p, [sc]);
  }
}
