// The Marauders: a neutral third faction. They hold any base nobody is
// playing, and (optionally) an outpost on the central hoard. They treat
// everyone the same: anyone who walks into their territory gets shot, and
// anyone who hurts them gets a raid party sent after them. They never go out
// looking for trouble on their own.

import { dist } from '../core/math';
import type { Unit } from './entities';
import type { Post } from './map';
import { NEUTRAL, SLOTS, type Camp, type Controller, type NeutralHook, type World } from './world';

const RAID_GRUDGE = 350;
const RAID_COOLDOWN = 120;
const RESPAWN = 45;

interface CampState {
  camp: Camp;
  grudge: number[];
  raidCd: number[];
  lastPos: ({ x: number; y: number } | null)[];
  spawnT: number;
  alive: boolean;
  postOf: Map<number, number>;
}

export class NeutralAI implements Controller, NeutralHook {
  private t = 0;
  private states: CampState[] = [];
  raids = 0;

  constructor(private w: World) {
    w.neutralHook = this;
    for (const camp of w.camps) {
      const st: CampState = {
        camp,
        grudge: new Array(SLOTS).fill(0),
        raidCd: new Array(SLOTS).fill(0),
        lastPos: new Array(SLOTS).fill(null),
        spawnT: RESPAWN,
        alive: true,
        postOf: new Map(),
      };
      w.units.filter((u) => u.owner === NEUTRAL && u.camp === camp.index).forEach((u, i) => st.postOf.set(u.id, i));
      this.states.push(st);
    }
  }

  private state(camp: number): CampState | undefined {
    return this.states.find((s) => s.camp.index === camp);
  }

  provoke(player: number, camp: number, amount: number, x: number, y: number): void {
    const st = this.state(camp);
    if (!st || player < 0 || player >= SLOTS) return;
    st.grudge[player] += amount;
    st.lastPos[player] = { x, y };
  }

  onFortressDestroyed(camp: number): void {
    const st = this.state(camp);
    if (st) st.alive = false;
  }

  update(dt: number): void {
    for (const st of this.states)
      for (let p = 0; p < SLOTS; p++) {
        st.grudge[p] *= Math.exp(-dt / 60);
        st.raidCd[p] = Math.max(0, st.raidCd[p] - dt);
      }
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.5;
    for (const st of this.states) this.think(st);
  }

  private think(st: CampState): void {
    const w = this.w;
    const z = st.camp.zone;
    const posts = st.camp.spot.posts;
    const mine = w.units.filter((u) => u.owner === NEUTRAL && !u.dead && u.camp === st.camp.index);

    // intruders inside the territory
    const intruders = w.units.filter(
      (u) => u.owner !== NEUTRAL && !u.dead && !u.container && dist(u.x, u.y, z.cx, z.cy) <= z.r && w.visibleTo(u, NEUTRAL),
    );
    for (const u of mine) {
      if (w.time < u.raidUntil) continue;
      const post = this.postFor(st, u, posts);
      if (intruders.length && (u.order.type === 'idle' || u.order.type === 'move')) {
        let best: Unit | null = null;
        let bd = Infinity;
        for (const it of intruders) {
          if (it.air && !u.def.weapons.some((wp) => wp.air)) continue;
          const d = dist(u.x, u.y, it.x, it.y);
          if (d < bd) {
            bd = d;
            best = it;
          }
        }
        if (best && bd < 16) {
          w.cmdAttack([u], best);
          continue;
        }
      }
      // too far from home (chased someone out, or a raid ended): go back
      const far = dist(u.x, u.y, z.cx, z.cy) > z.r + 5;
      if ((u.order.type === 'idle' && dist(u.x, u.y, post.x, post.y) > 3) || (u.order.type === 'attack' && far)) {
        w.cmdMove([u], post.x, post.y);
        u.anchorX = post.x;
        u.anchorY = post.y;
      }
    }

    // retaliation raids against whoever provoked this camp
    for (let p = 0; p < SLOTS; p++) {
      if (st.grudge[p] < RAID_GRUDGE || st.raidCd[p] > 0 || !w.players[p].active || w.players[p].defeated) continue;
      const free = mine.filter((u) => w.time >= u.raidUntil);
      if (free.length < 2) continue;
      free.sort((a, b) => b.def.hp * (b.def.members ?? 1) - a.def.hp * (a.def.members ?? 1));
      const party = free.slice(0, Math.max(2, Math.ceil(free.length * 0.6)));
      const target = this.raidTarget(st, p);
      for (const u of party) u.raidUntil = w.time + 55;
      w.cmdMove(party, target.x, target.y, true);
      st.raidCd[p] = RAID_COOLDOWN;
      st.grudge[p] = 0;
      this.raids++;
      w.alert(p, 'marauder-raid', 'You provoked the Marauders - a raid party is coming for you!', z.cx, z.cy, 'warn', 10);
    }

    // reinforcements while the stronghold stands
    if (!st.alive) return;
    st.spawnT -= 0.5;
    if (st.spawnT > 0) return;
    st.spawnT = RESPAWN;
    const taken = new Set<number>();
    for (const u of mine) {
      const i = st.postOf.get(u.id);
      if (i !== undefined) taken.add(i);
    }
    const free = posts.findIndex((_, i) => !taken.has(i));
    const fort = w.buildings.find((b) => b.key === 'fortress' && !b.dead && b.camp === st.camp.index);
    if (free < 0 || !fort) return;
    const post = posts[free];
    const u = w.spawnUnit(NEUTRAL, post.key, fort.x, fort.y + 3);
    u.territorial = true;
    u.camp = st.camp.index;
    st.postOf.set(u.id, free);
    w.cmdMove([u], post.x, post.y);
    u.anchorX = post.x;
    u.anchorY = post.y;
  }

  private postFor(st: CampState, u: Unit, posts: Post[]): { x: number; y: number } {
    let i = st.postOf.get(u.id);
    if (i === undefined) {
      i = st.postOf.size % posts.length;
      st.postOf.set(u.id, i);
    }
    return posts[i];
  }

  /** Raid the provoker's nearest structure if it's close, otherwise wherever they attacked from. */
  private raidTarget(st: CampState, p: number): { x: number; y: number } {
    const w = this.w;
    const z = st.camp.zone;
    let best: { x: number; y: number } | null = null;
    let bd = 40;
    for (const b of w.buildingsOf(p)) {
      const d = dist(b.x, b.y, z.cx, z.cy);
      if (d < bd) {
        bd = d;
        best = { x: b.x, y: b.y };
      }
    }
    return best ?? st.lastPos[p] ?? { x: z.cx, y: z.cy };
  }
}
