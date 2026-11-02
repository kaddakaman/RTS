import { Rng } from '../src/core/math';
import type { UnitKey } from '../src/data/defs';
import { World, type MatchSetup } from '../src/sim/world';

type F = 'coalition' | 'sythari';

/** A four-player world with the starting units removed: an empty arena on the central plateau. */
export function arena(fa: F, fb: F): World {
  const setup: MatchSetup = {
    slots: [
      { kind: 'local', faction: fa, team: 0, name: 'A' },
      { kind: 'local', faction: fb, team: 1, name: 'B' },
      { kind: 'local', faction: 'coalition', team: 2, name: 'C' },
      { kind: 'local', faction: 'coalition', team: 3, name: 'D' },
    ],
    centerOutpost: false,
  };
  const w = new World(setup);
  w.collectFx = false;
  for (const u of w.units) u.dead = true;
  w.update(0.01);
  return w;
}

/** Two groups attack-move into each other. Returns remaining health (in "units") for each side. */
export function duel(a: UnitKey[], b: UnitKey[], fa: F = 'coalition', fb: F = 'coalition', defense?: 'sam' | 'bunker' | 'arty') {
  const w = arena(fa, fb);
  const A = a.map((k, i) => w.spawnUnit(0, k, 42 + (i % 2), 46 + Math.floor(i / 2) * 1.3));
  const B = b.map((k, i) => w.spawnUnit(1, k, 53 + (i % 2), 46 + Math.floor(i / 2) * 1.3));
  if (defense) w.addBuilding(1, defense, 54, 50, true);
  w.cmdMove(A, 53, 47, true);
  w.cmdMove(B, 42, 47, true);
  const defLeft = () => (defense ? w.buildings.filter((x) => x.owner === 1 && !x.dead && x.key === defense) : []);
  for (let t = 0; t < 120; t += 1 / 30) {
    w.update(1 / 30);
    if (!A.some((u) => !u.dead) || (!B.some((u) => !u.dead) && !defLeft().length)) break;
  }
  const hp = (L: typeof A) => L.filter((u) => !u.dead).reduce((s, u) => s + u.hp / u.maxHp, 0);
  return { a: hp(A), b: hp(B) + defLeft().reduce((s, x) => s + x.hp / x.maxHp, 0) };
}

/** Runs a duel several times; returns how many times side A won. */
export function winsA(n: number, ...args: Parameters<typeof duel>): number {
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const r = duel(...args);
    if (r.a > r.b) wins++;
  }
  return wins;
}

/** Makes Math.random repeatable so fights come out the same every run. */
export function seedRandom(seed: number): void {
  const r = new Rng(seed);
  Math.random = () => r.next();
}
