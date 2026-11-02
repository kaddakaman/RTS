// The battlefield: terrain tiles, the symmetric map layout, line of sight and
// movement rules.

import { valueNoise } from '../core/math';
import type { MoveClass } from '../data/defs';

export const Tile = {
  Low: 0,
  High: 1,
  Cliff: 2,
  Rock: 3,
  Water: 4,
  Forest: 5,
  Ramp: 6,
} as const;
export type TileType = (typeof Tile)[keyof typeof Tile];

export const MAP_W = 96;
export const MAP_H = 96;

// Per tile type: [foot passable, wheel passable, buildable, vision height]
const PASS_FOOT = [1, 1, 0, 0, 0, 1, 1];
const PASS_WHEEL = [1, 1, 0, 0, 0, 0, 1];
const BUILDABLE = [1, 1, 0, 0, 0, 0, 0];
const VISION_H = [0, 1, 1, 9, 0, 0, 0];

export interface Pt {
  x: number;
  y: number;
}

export interface Post extends Pt {
  key: 'raider' | 'rocketeer' | 'technical' | 'junker';
}

/** Where a Marauder camp goes: a stronghold, towers and guards inside a territory circle. */
export interface CampSpot {
  cx: number;
  cy: number;
  r: number;
  fortress: Pt;
  towers: Pt[];
  posts: Post[];
}

export interface StartSpot {
  hq: Pt;
  rally: Pt;
  ramps: Pt[];
  /** Used when nobody plays this base: the Marauders move in. */
  camp: CampSpot;
}

export interface PileSpot extends Pt {
  amount: number;
  label: string;
}

/** Hostile neutral territory: paths avoid it unless they're heading into it. */
export interface Zone {
  cx: number;
  cy: number;
  r: number;
  active: boolean;
}

export class GameMap {
  readonly w = MAP_W;
  readonly h = MAP_H;
  readonly tiles = new Uint8Array(MAP_W * MAP_H);
  /** Entity id of the building or supply cache standing on each tile (0 = free). */
  readonly occ = new Int32Array(MAP_W * MAP_H);
  /** Bumped whenever occupancy changes, so cached paths are rebuilt. */
  version = 0;
  starts: StartSpot[] = [];
  piles: PileSpot[] = [];
  center!: CampSpot;
  /** Active Marauder territories (filled in by the World). */
  zones: Zone[] = [];
  name = 'Ember Basin';

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  tileAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return Tile.Rock;
    return this.tiles[y * this.w + x];
  }

  /** Can a unit of this movement class stand on tile index i? */
  passable(i: number, cls: MoveClass): boolean {
    if (cls === 'air') return true;
    if (this.occ[i] !== 0) return false;
    const t = this.tiles[i];
    return cls === 'foot' ? PASS_FOOT[t] === 1 : PASS_WHEEL[t] === 1;
  }

  passableXY(x: number, y: number, cls: MoveClass): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!this.inBounds(tx, ty)) return false;
    return this.passable(ty * this.w + tx, cls);
  }

  terrainPassable(i: number, cls: MoveClass): boolean {
    if (cls === 'air') return true;
    const t = this.tiles[i];
    return cls === 'foot' ? PASS_FOOT[t] === 1 : PASS_WHEEL[t] === 1;
  }

  buildable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const i = y * this.w + x;
    return BUILDABLE[this.tiles[i]] === 1 && this.occ[i] === 0;
  }

  visionHeight(i: number): number {
    return VISION_H[this.tiles[i]];
  }

  isForest(i: number): boolean {
    return this.tiles[i] === Tile.Forest;
  }

  /** Movement cost multiplier (forest slows infantry). */
  speedMult(x: number, y: number, cls: MoveClass): number {
    if (cls !== 'foot') return 1;
    return this.tileAt(Math.floor(x), Math.floor(y)) === Tile.Forest ? 0.65 : 1;
  }

  setOcc(x: number, y: number, w: number, h: number, id: number): void {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) if (this.inBounds(xx, yy)) this.occ[yy * this.w + xx] = id;
    this.version++;
  }

  clearOcc(x: number, y: number, w: number, h: number, id: number): void {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        if (!this.inBounds(xx, yy)) continue;
        const i = yy * this.w + xx;
        if (this.occ[i] === id) this.occ[i] = 0;
      }
    this.version++;
  }

  /** Is the straight segment between two points walkable for this class? */
  lineClear(x0: number, y0: number, x1: number, y1: number, cls: MoveClass, pad = 0.28): boolean {
    if (cls === 'air') return true;
    const d = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(d / 0.25);
    const nx = d > 0 ? -(y1 - y0) / d : 0;
    const ny = d > 0 ? (x1 - x0) / d : 0;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (!this.passableXY(x, y, cls)) return false;
      if (pad > 0 && (!this.passableXY(x + nx * pad, y + ny * pad, cls) || !this.passableXY(x - nx * pad, y - ny * pad, cls))) return false;
    }
    return true;
  }

  /** Nearest passable tile centre to a point (searching outwards). */
  nearestPassable(x: number, y: number, cls: MoveClass, maxR = 12): { x: number; y: number } | null {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (this.inBounds(tx, ty) && this.passable(this.idx(tx, ty), cls)) return { x, y };
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const xx = tx + dx;
          const yy = ty + dy;
          if (!this.inBounds(xx, yy) || !this.passable(this.idx(xx, yy), cls)) continue;
          const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y);
          if (d < bestD) {
            bestD = d;
            best = { x: xx + 0.5, y: yy + 0.5 };
          }
        }
      if (best) return best;
    }
    return null;
  }
}

// ---------------------------------------------------------------- map generation

/**
 * "Ember Basin": a four-base map with 90-degree rotational symmetry, loosely
 * inspired by classic eight-player desert maps. Each base sits on a plateau at
 * the map edge with a wide main ramp facing the middle and a narrow side ramp
 * facing a corner. The middle is a raised plateau holding a big supply hoard,
 * surrounded by a moat with four crossings.
 */
export function generateMap(): GameMap {
  const m = new GameMap();
  const S = m.w;
  const t = m.tiles;
  // tile (x, y) rotated k quarter-turns clockwise about the map centre
  const rotT = (x: number, y: number, k: number): [number, number] => {
    for (let i = 0; i < k; i++) [x, y] = [S - 1 - y, x];
    return [x, y];
  };
  const set = (x: number, y: number, v: number) => {
    if (!m.inBounds(x, y)) return;
    for (let k = 0; k < 4; k++) {
      const [rx, ry] = rotT(x, y, k);
      t[ry * S + rx] = v;
    }
  };
  const get = (x: number, y: number) => t[y * S + x];
  // noise evaluated on the canonical member of each group of four rotated tiles
  const cn = (x: number, y: number, scale: number, seed: number) => {
    let bx = x;
    let by = y;
    let bi = y * S + x;
    for (let k = 1; k < 4; k++) {
      const [rx, ry] = rotT(x, y, k);
      const i = ry * S + rx;
      if (i < bi) {
        bi = i;
        bx = rx;
        by = ry;
      }
    }
    return valueNoise(bx / scale, by / scale, seed);
  };
  const forEach = (fn: (x: number, y: number) => void) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) fn(x, y);
  };
  const C = S / 2;

  t.fill(Tile.Low);

  // Base plateau (slot 0 is at the bottom edge; the others are rotations of it).
  forEach((x, y) => {
    if (x < 20 || x > 47 || y < 71) return;
    const cornerL = x < 25 && y < 76 && Math.hypot(x - 25, y - 76) > 5;
    const cornerR = x > 42 && y < 76 && Math.hypot(x - 42, y - 76) > 5;
    if (!cornerL && !cornerR) set(x, y, Tile.High);
  });

  // Central plateau ringed by a moat with four crossings.
  forEach((x, y) => {
    const dx = x + 0.5 - C;
    const dy = y + 0.5 - C;
    const r = Math.hypot(dx, dy);
    const bridge = Math.abs(dx) < 1.6 || Math.abs(dy) < 1.6;
    if (r <= 9) set(x, y, Tile.High);
    else if (r < 12.6 + (cn(x, y, 4, 5) - 0.5) * 1.2 && !bridge) set(x, y, Tile.Water);
  });

  // Rocks and ridges (cover, line-of-sight blockers and chokepoints).
  const blob = (cx: number, cy: number, r: number, v: number, only: number[] = [Tile.Low]) => {
    forEach((x, y) => {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const wob = (cn(x, y, 3, 7) - 0.5) * 1.4;
      if (d <= r + wob && only.includes(get(x, y))) set(x, y, v);
    });
  };
  const ridge = (x0: number, y0: number, x1: number, y1: number, w: number) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    for (let i = 0; i <= n; i++) {
      const px = x0 + ((x1 - x0) * i) / n;
      const py = y0 + ((y1 - y0) * i) / n;
      for (let y = Math.floor(py - w - 1); y <= py + w + 1; y++)
        for (let x = Math.floor(px - w - 1); x <= px + w + 1; x++) {
          if (!m.inBounds(x, y) || get(x, y) !== Tile.Low) continue;
          const wob = (cn(x, y, 3, 11) - 0.5) * 0.9;
          if (Math.hypot(x + 0.5 - px, y + 0.5 - py) <= w + wob) set(x, y, Tile.Rock);
        }
    }
  };
  // ridges between neighbouring bases, leaving gaps to fight over
  ridge(52, 72, 58, 78, 1.1);
  ridge(62, 84, 66, 92, 1.1);
  ridge(55, 60, 62, 57, 1.0);
  blob(30, 66, 1.8, Tile.Rock);
  blob(60, 66, 1.6, Tile.Rock);
  blob(13, 70, 2.0, Tile.Rock);

  // Forests: infantry can walk through (slowly) and hide; vehicles can't enter.
  blob(52, 86, 2.6, Tile.Forest);
  blob(26, 62, 2.2, Tile.Forest);
  blob(66, 70, 2.2, Tile.Forest);
  blob(9, 78, 2.0, Tile.Forest);
  blob(46, 63, 1.4, Tile.Forest);

  // Cliffs around plateaus.
  const isLowish = (v: number) => v === Tile.Low || v === Tile.Forest || v === Tile.Water || v === Tile.Rock;
  const cliffs: number[] = [];
  forEach((x, y) => {
    if (get(x, y) !== Tile.High) return;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if ((dx || dy) && m.inBounds(xx, yy) && isLowish(get(xx, yy))) {
          cliffs.push(y * S + x);
          return;
        }
      }
  });
  for (const i of cliffs) t[i] = Tile.Cliff;

  // Ramps: the main ramp (4 wide) towards the middle, a narrow side ramp towards
  // the corner, and the four bridge ramps up to the central plateau.
  for (let y = 69; y <= 72; y++) for (let x = 38; x <= 41; x++) set(x, y, Tile.Ramp);
  for (let y = 83; y <= 84; y++) for (let x = 18; x <= 21; x++) set(x, y, Tile.Ramp);
  forEach((x, y) => {
    const dx = x + 0.5 - C;
    const dy = y + 0.5 - C;
    const r = Math.hypot(dx, dy);
    if (Math.abs(dx) < 1.6 && dy > 0 && r > 7.4 && r < 10.2) set(x, y, Tile.Ramp);
  });
  // keep ramp exits clear
  for (let y = 64; y <= 68; y++) for (let x = 37; x <= 42; x++) set(x, y, Tile.Low);
  for (let y = 82; y <= 85; y++) for (let x = 15; x <= 17; x++) set(x, y, Tile.Low);

  // ---- spawn data, defined for slot 0 and rotated for the others
  const rotP = (p: Pt, k: number): Pt => {
    let { x, y } = p;
    for (let i = 0; i < k; i++) [x, y] = [S - y, x];
    return { x, y };
  };
  /** Rotates the top-left corner of a w*h rectangle (square footprints only). */
  const rotR = (p: Pt, size: number, k: number): Pt => {
    let { x, y } = p;
    for (let i = 0; i < k; i++) [x, y] = [S - y - size, x];
    return { x, y };
  };
  const base0 = {
    hq: { x: 30, y: 84 },
    rally: { x: 36.5, y: 63.5 },
    ramps: [
      { x: 40, y: 71 },
      { x: 20, y: 84 },
    ],
    camp: {
      cx: 33.5,
      cy: 83.5,
      r: 13,
      fortress: { x: 30, y: 84 },
      towers: [
        { x: 35, y: 74 },
        { x: 23, y: 80 },
      ],
      posts: [
        { x: 37.5, y: 78.5, key: 'raider' },
        { x: 42.5, y: 77.5, key: 'technical' },
        { x: 25.5, y: 87.5, key: 'raider' },
        { x: 43.5, y: 91.5, key: 'rocketeer' },
        { x: 34.5, y: 92.5, key: 'junker' },
      ] as Post[],
    },
  };
  for (let k = 0; k < 4; k++) {
    const c = base0.camp;
    const cc = rotP({ x: c.cx, y: c.cy }, k);
    m.starts.push({
      hq: rotR(base0.hq, 4, k),
      rally: rotP(base0.rally, k),
      ramps: base0.ramps.map((r) => rotP(r, k)),
      camp: {
        cx: cc.x,
        cy: cc.y,
        r: c.r,
        fortress: rotR(c.fortress, 4, k),
        towers: c.towers.map((tw) => rotR(tw, 2, k)),
        posts: c.posts.map((p) => ({ ...rotP(p, k), key: p.key })),
      },
    });
  }

  const pile = (x: number, y: number, amount: number, label: string) => {
    for (let k = 0; k < 4; k++) {
      const r = rotR({ x, y }, 2, k);
      m.piles.push({ x: r.x, y: r.y, amount, label });
    }
  };
  pile(38, 88, 10000, 'Main cache');
  pile(42, 61, 6000, 'Forward cache');
  pile(56, 65, 5000, 'Field cache');
  pile(6, 88, 6000, 'Corner cache');
  pile(42, 52, 4000, 'Central hoard');

  // make sure caches sit on open ground
  for (const p of m.piles)
    for (let y = p.y - 1; y <= p.y + 2; y++)
      for (let x = p.x - 1; x <= p.x + 2; x++) {
        if (!m.inBounds(x, y)) continue;
        const v = get(x, y);
        if (v === Tile.Forest || v === Tile.Rock || v === Tile.Water) t[y * S + x] = Tile.Low;
      }

  const centerPost: Post = { x: 44.5, y: 55.5, key: 'raider' };
  m.center = {
    cx: C,
    cy: C,
    r: 9.6,
    fortress: { x: C - 2, y: C - 2 },
    towers: [],
    posts: [0, 1, 2, 3].map((k) => ({ ...rotP(centerPost, k), key: centerPost.key })),
  };
  return m;
}

// ---------------------------------------------------------------- vision

/**
 * Every tile within radius r, nearest first, each pointing at its "parent":
 * the tile one step closer along the straight line back to the observer.
 * A tile is visible if its parent is visible and doesn't block sight, which
 * gives gap-free line of sight in a single pass.
 */
interface VisionTree {
  dx: Int8Array;
  dy: Int8Array;
  parent: Int32Array;
}

const treeCache = new Map<number, VisionTree>();

function visionTree(r: number): VisionTree {
  const cached = treeCache.get(r);
  if (cached) return cached;
  const cells: { dx: number; dy: number; d: number }[] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= r + 0.5 && (dx || dy)) cells.push({ dx, dy, d });
    }
  cells.sort((a, b) => a.d - b.d);
  const index = new Map<string, number>();
  cells.forEach((c, i) => index.set(`${c.dx},${c.dy}`, i));
  const n = cells.length;
  const t: VisionTree = { dx: new Int8Array(n), dy: new Int8Array(n), parent: new Int32Array(n) };
  cells.forEach((c, i) => {
    t.dx[i] = c.dx;
    t.dy[i] = c.dy;
    if (c.d <= 1.5) {
      t.parent[i] = -1;
      return;
    }
    const k = (c.d - 1) / c.d;
    const px = Math.round(c.dx * k);
    const py = Math.round(c.dy * k);
    t.parent[i] = px === 0 && py === 0 ? -1 : (index.get(`${px},${py}`) ?? -1);
  });
  treeCache.set(r, t);
  return t;
}

let scratchVis = new Uint8Array(0);
let scratchPass = new Uint8Array(0);

/**
 * Marks every tile visible from (ox, oy) within radius r.
 * Sight is blocked by rock, by higher ground (you can see the cliff edge but
 * not past it) and by scrub forests (you can see into the first tile only).
 */
export function castVision(map: GameMap, out: Uint8Array, ox: number, oy: number, r: number, flying: boolean): void {
  const W = map.w;
  const H = map.h;
  const tx = Math.floor(ox);
  const ty = Math.floor(oy);
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return;
  out[ty * W + tx] = 1;
  const t = visionTree(Math.max(1, Math.round(r)));
  const n = t.parent.length;
  if (flying) {
    for (let i = 0; i < n; i++) {
      const x = tx + t.dx[i];
      const y = ty + t.dy[i];
      if (x >= 0 && y >= 0 && x < W && y < H) out[y * W + x] = 1;
    }
    return;
  }
  if (scratchVis.length < n) {
    scratchVis = new Uint8Array(n);
    scratchPass = new Uint8Array(n);
  }
  const vis = scratchVis;
  const pass = scratchPass;
  const tiles = map.tiles;
  const h0 = VISION_H[tiles[ty * W + tx]];
  for (let i = 0; i < n; i++) {
    const x = tx + t.dx[i];
    const y = ty + t.dy[i];
    if (x < 0 || y < 0 || x >= W || y >= H) {
      vis[i] = 0;
      pass[i] = 0;
      continue;
    }
    const p = t.parent[i];
    const v = p < 0 ? 1 : vis[p] & pass[p];
    vis[i] = v;
    if (v) {
      const j = y * W + x;
      out[j] = 1;
      const tt = tiles[j];
      pass[i] = VISION_H[tt] > h0 || tt === Tile.Forest ? 0 : 1;
    } else pass[i] = 0;
  }
}
