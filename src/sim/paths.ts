// Path finding with cached flow fields: one Dijkstra pass from a goal gives
// every tile on the map its distance to that goal, so any number of units
// heading to the same place share a single computation.

import type { MoveClass } from '../data/defs';
import type { GameMap } from './map';

const SQRT2 = Math.SQRT2;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

export class FlowField {
  constructor(
    readonly key: string,
    readonly cls: MoveClass,
    readonly dist: Float32Array,
    readonly version: number,
    readonly goalX: number,
    readonly goalY: number,
  ) {}
  lastUsed = 0;

  at(map: GameMap, x: number, y: number): number {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!map.inBounds(tx, ty)) return Infinity;
    return this.dist[ty * map.w + tx];
  }

  /** Tile index of the best neighbour to step to from tile i (or -1). */
  next(map: GameMap, i: number): number {
    const W = map.w;
    const x = i % W;
    const y = (i - x) / W;
    let best = -1;
    let bestD = this.dist[i];
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= map.h) continue;
      const j = ny * W + nx;
      if (k >= 4) {
        // no corner cutting
        if (!map.passable(y * W + nx, this.cls) || !map.passable(ny * W + x, this.cls)) continue;
      }
      const d = this.dist[j];
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    return best;
  }
}

/** Tiny binary min-heap over (priority, tile index). */
class Heap {
  pri: Float32Array;
  val: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.pri = new Float32Array(cap);
    this.val = new Int32Array(cap);
  }
  push(p: number, v: number): void {
    if (this.size >= this.pri.length) {
      const np = new Float32Array(this.pri.length * 2);
      np.set(this.pri);
      const nv = new Int32Array(this.val.length * 2);
      nv.set(this.val);
      this.pri = np;
      this.val = nv;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.pri[parent] <= p) break;
      this.pri[i] = this.pri[parent];
      this.val[i] = this.val[parent];
      i = parent;
    }
    this.pri[i] = p;
    this.val[i] = v;
  }
  pop(): number {
    const top = this.val[0];
    const lastP = this.pri[--this.size];
    const lastV = this.val[this.size];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.pri[c + 1] < this.pri[c]) c++;
      if (this.pri[c] >= lastP) break;
      this.pri[i] = this.pri[c];
      this.val[i] = this.val[c];
      i = c;
    }
    this.pri[i] = lastP;
    this.val[i] = lastV;
    return top;
  }
  topPri(): number {
    return this.pri[0];
  }
}

export class PathCache {
  private cache = new Map<string, FlowField>();
  private heap: Heap;
  private clock = 0;
  computed = 0;

  constructor(private map: GameMap) {
    this.heap = new Heap(map.w * map.h * 2);
  }

  /** Flow field towards the point (x, y). */
  field(x: number, y: number, cls: MoveClass): FlowField | null {
    if (cls === 'air') return null;
    const map = this.map;
    const tx = Math.max(0, Math.min(map.w - 1, Math.floor(x)));
    const ty = Math.max(0, Math.min(map.h - 1, Math.floor(y)));
    // avoid every hostile territory except the one we're heading into
    let mask = 0;
    map.zones.forEach((z, i) => {
      if (z.active && Math.hypot(x - z.cx, y - z.cy) > z.r + 1) mask |= 1 << i;
    });
    const key = `${cls}|${tx},${ty}|${mask}`;
    this.clock++;
    const hit = this.cache.get(key);
    if (hit && hit.version === map.version) {
      hit.lastUsed = this.clock;
      return hit;
    }
    const f = this.compute(key, tx, ty, cls, mask);
    f.lastUsed = this.clock;
    this.cache.set(key, f);
    if (this.cache.size > 48) {
      let oldK = '';
      let old = Infinity;
      for (const [k, v] of this.cache)
        if (v.lastUsed < old) {
          old = v.lastUsed;
          oldK = k;
        }
      this.cache.delete(oldK);
    }
    return f;
  }

  private penalties = new Map<number, Float32Array>();

  /** Extra path cost per tile for the territories in `mask`. */
  private penalty(mask: number): Float32Array | null {
    if (!mask) return null;
    let p = this.penalties.get(mask);
    if (p) return p;
    const map = this.map;
    p = new Float32Array(map.w * map.h);
    map.zones.forEach((z, i) => {
      if (!(mask & (1 << i))) return;
      for (let y = 0; y < map.h; y++)
        for (let x = 0; x < map.w; x++) if (Math.hypot(x + 0.5 - z.cx, y + 0.5 - z.cy) < z.r) p![y * map.w + x] += 5;
    });
    this.penalties.set(mask, p);
    return p;
  }

  private compute(key: string, tx: number, ty: number, cls: MoveClass, mask: number): FlowField {
    this.computed++;
    const map = this.map;
    const W = map.w;
    const H = map.h;
    const N = W * H;
    const dist = new Float32Array(N).fill(Infinity);
    const heap = this.heap;
    heap.size = 0;
    // Seeds: the goal tile, or the ring of nearest passable tiles around it
    // (e.g. when the goal is a building).
    const gi = ty * W + tx;
    if (map.passable(gi, cls)) {
      dist[gi] = 0;
      heap.push(0, gi);
    } else {
      for (let r = 1; r <= 10 && heap.size === 0; r++) {
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = tx + dx;
            const y = ty + dy;
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const i = y * W + x;
            if (!map.passable(i, cls)) continue;
            dist[i] = 0;
            heap.push(0, i);
          }
        // also accept tiles one ring further so all sides of a building are seeded
        if (heap.size > 0 && r < 10) {
          const r2 = r + 1;
          for (let dy = -r2; dy <= r2; dy++)
            for (let dx = -r2; dx <= r2; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r2) continue;
              const x = tx + dx;
              const y = ty + dy;
              if (x < 0 || y < 0 || x >= W || y >= H) continue;
              const i = y * W + x;
              if (!map.passable(i, cls) || dist[i] === 0) continue;
              dist[i] = 0.5;
              heap.push(0.5, i);
            }
        }
      }
    }
    const pen = this.penalty(mask);
    while (heap.size > 0) {
      const d0 = heap.topPri();
      const i = heap.pop();
      if (d0 > dist[i]) continue;
      const x = i % W;
      const y = (i - x) / W;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (!map.passable(j, cls)) continue;
        let step = 1;
        if (k >= 4) {
          if (!map.passable(y * W + nx, cls) || !map.passable(ny * W + x, cls)) continue;
          step = SQRT2;
        }
        if (cls === 'foot' && map.isForest(j)) step *= 1.6;
        if (pen) step += pen[j];
        const nd = d0 + step;
        if (nd < dist[j]) {
          dist[j] = nd;
          heap.push(nd, j);
        }
      }
    }
    return new FlowField(key, cls, dist, map.version, tx + 0.5, ty + 0.5);
  }

  clear(): void {
    this.cache.clear();
    this.penalties.clear();
  }
}
