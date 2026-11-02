import { beforeEach, describe, expect, it } from 'vitest';
import { FACTIONS, UPGRADE } from '../src/data/defs';
import { castVision, generateMap, Tile } from '../src/sim/map';
import { createMatch, duel as duelSetup } from '../src/sim/match';
import { NEUTRAL, World, type MatchSetup } from '../src/sim/world';
import { arena, seedRandom } from './helpers';

beforeEach(() => seedRandom(777));

const step = (w: World, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 30) w.update(1 / 30);
};

describe('map', () => {
  const m = generateMap();
  it('is identical when rotated a quarter turn (fair for all four bases)', () => {
    const S = m.w;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) expect(m.tiles[y * S + x]).toBe(m.tiles[x * S + (S - 1 - y)]);
  });
  it('has four bases on high ground, each with a main and a side ramp', () => {
    expect(m.starts.length).toBe(4);
    for (const s of m.starts) {
      expect(m.tileAt(s.hq.x + 1, s.hq.y + 1)).toBe(Tile.High);
      expect(s.ramps.length).toBe(2);
      for (const r of s.ramps) expect(m.tileAt(Math.floor(r.x), Math.floor(r.y))).toBe(Tile.Ramp);
    }
  });
  it('lets vehicles drive from every base to every other base', () => {
    const w = new World(duelSetup('coalition', 'sythari', 'normal', 'normal', false));
    const field = w.paths.field(m.starts[0].rally.x, m.starts[0].rally.y, 'wheel')!;
    for (const s of m.starts) expect(field.at(w.map, s.rally.x, s.rally.y)).toBeLessThan(Infinity);
  });
  it('spreads supply caches around the map', () => {
    expect(m.piles.length).toBe(20);
  });
});

describe('line of sight', () => {
  const m = generateMap();
  // a tile on top of the south-west plateau, ~10 tiles from the low ground below it
  const hq = { x: 31, y: 75 };
  it('units below a cliff cannot see on top of the plateau', () => {
    const vis = new Uint8Array(m.w * m.h);
    // stand on low ground just north of the base plateau and look south
    expect(m.tileAt(34, 67)).toBe(Tile.Low);
    castVision(m, vis, 34.5, 67.5, 12, false);
    expect(vis[Math.floor(hq.y + 1) * m.w + Math.floor(hq.x + 1)]).toBe(0);
  });
  it('units on the plateau can see the low ground below', () => {
    const vis = new Uint8Array(m.w * m.h);
    castVision(m, vis, 30.5, 75.5, 12, false);
    expect(vis[66 * m.w + 30]).toBe(1);
  });
  it('aircraft see over everything', () => {
    const vis = new Uint8Array(m.w * m.h);
    castVision(m, vis, 34.5, 67.5, 12, true);
    expect(vis[Math.floor(hq.y + 1) * m.w + Math.floor(hq.x + 1)]).toBe(1);
  });
});

describe('economy and building', () => {
  it('supply trucks haul supplies from the cache to the HQ', () => {
    const w = new World(duelSetup('coalition', 'sythari', null, null, false));
    w.collectFx = false;
    const start = w.players[0].supplies;
    const pile = w.nearestPile(w.players[0].hq!.x, w.players[0].hq!.y)!;
    const before = pile.amount;
    step(w, 60);
    expect(w.players[0].supplies).toBeGreaterThan(start + 200);
    expect(pile.amount).toBeLessThan(before);
  });

  it('builders construct buildings and tech requirements are enforced', () => {
    const w = new World(duelSetup('coalition', 'sythari', null, null, false));
    w.collectFx = false;
    const me = 0;
    const builder = w.units.find((u) => u.owner === me && u.key === 'builder')!;
    expect(w.requirement(me, 'factory')).toMatch(/Tier 2/);
    expect(w.requirement(me, 'defense')).toMatch(/Barracks/);
    // find a valid spot for barracks near the HQ
    const hq = w.players[me].hq!;
    let placed = false;
    for (let dx = -8; dx <= 8 && !placed; dx++)
      for (let dy = -8; dy <= 8 && !placed; dy++) {
        const r = w.startConstruction(me, 'barracks', hq.tx + dx, hq.ty + dy, [builder]);
        if (typeof r !== 'string') placed = true;
      }
    expect(placed).toBe(true);
    step(w, 40);
    const bk = w.buildings.find((b) => b.owner === me && b.key === 'barracks')!;
    expect(bk.built).toBe(true);
    expect(w.queueUnit(bk, 'rifle')).toBe('');
    step(w, 20);
    expect(w.units.some((u) => u.owner === me && u.key === 'rifle')).toBe(true);
  });

  it('the HQ upgrade unlocks the next tier', () => {
    const w = new World(duelSetup('coalition', 'sythari', null, null, false));
    w.collectFx = false;
    w.players[0].supplies = 5000;
    expect(w.queueResearch(w.players[0].hq!, 'tier2')).toBe('');
    step(w, 50);
    expect(w.players[0].tier).toBe(2);
    expect(w.requirement(0, 'factory')).toBe('');
  });
});

describe('Marauders', () => {
  const setup = (): World => {
    const w = createMatch(duelSetup('coalition', 'sythari', null, null, true));
    w.collectFx = false;
    return w;
  };

  it('occupy the bases nobody plays and the centre', () => {
    const w = setup();
    expect(w.camps.length).toBe(3);
    expect(w.buildings.filter((b) => b.key === 'fortress').length).toBe(3);
  });

  it('leave you alone outside their territory', () => {
    const w = setup();
    const z = w.camps.find((c) => c.index === 4)!.zone;
    // park a squad just outside the central territory
    const u = w.spawnUnit(0, 'rifle', z.cx, z.cy + z.r + 3.5);
    step(w, 20);
    expect(u.dead).toBe(false);
    expect(u.hp).toBe(u.maxHp);
  });

  it('attack whoever walks into their territory', () => {
    const w = setup();
    const z = w.camps.find((c) => c.index === 4)!.zone;
    const u = w.spawnUnit(0, 'rifle', z.cx + 0.5, z.cy + 5);
    step(w, 15);
    expect(u.dead || u.hp < u.maxHp).toBe(true);
  });

  it('send a raid party after anyone who attacks them', () => {
    const w = setup();
    const target = w.buildings.find((b) => b.owner === NEUTRAL && b.camp === 4)!;
    const nh: any = w.neutralHook;
    // a long-range attacker shells their stronghold
    for (let i = 0; i < 10; i++) w.damage(target, 60, 'cannon', 0, 0, 30, 30);
    step(w, 2);
    expect(nh.raids).toBeGreaterThan(0);
  });

  it('pay a bounty and free their supplies when their stronghold falls', () => {
    const w = setup();
    const fort = w.buildings.find((b) => b.key === 'fortress' && b.camp === 4)!;
    const before = w.players[0].supplies;
    w.damage(fort, 1e6, 'cannon', 0, 0, 40, 40);
    expect(w.players[0].supplies).toBeGreaterThan(before);
    expect(w.camps.find((c) => c.index === 4)!.zone.active).toBe(false);
  });
});

describe('special units', () => {
  it('a dropship carries infantry over cliffs and unloads them', () => {
    const w = arena('coalition', 'sythari');
    const ship = w.spawnUnit(0, 'dropship', 40, 48);
    const squad = w.spawnUnit(0, 'rifle', 42, 48);
    w.cmdEnter([squad], ship);
    step(w, 3);
    expect(squad.container).toBe(ship.id);
    // fly onto the top-left base plateau and drop them
    const dest = w.map.starts[1].hq;
    w.cmdMove([ship], dest.x + 6, dest.y + 2);
    step(w, 15);
    w.cmdAbility(0, [ship]);
    expect(squad.container).toBe(0);
    expect(w.map.tileAt(Math.floor(squad.x), Math.floor(squad.y))).toBe(Tile.High);
  });

  it('infantry inside a gunner emplacement hit harder and are protected', () => {
    const w = arena('coalition', 'sythari');
    const bunker = w.addBuilding(0, 'bunker', 44, 47, true);
    const squad = w.spawnUnit(0, 'rifle', 47, 48);
    w.cmdEnter([squad], bunker);
    step(w, 3);
    expect(bunker.garrison).toBe(squad);
    const hp = squad.hp;
    w.damage(bunker, 100, 'small', 1, 0, 50, 50);
    expect(hp - squad.hp).toBeLessThan(100 * 0.5);
  });

  it('bombers fly back to an air base to rearm after a run', () => {
    const w = arena('coalition', 'sythari');
    w.addBuilding(0, 'airbase', 40, 42, true);
    const bomber = w.spawnUnit(0, 'bomber', 42, 44);
    const tank = w.spawnUnit(1, 'tank', 54, 48);
    w.players[0].recon.push({ x: 54, y: 48, until: 999 });
    w.updateFog(w.players[0].team);
    w.cmdAttack([bomber], tank);
    step(w, 4);
    expect(bomber.ammo).toBe(0);
    expect(tank.hp).toBeLessThan(tank.maxHp);
    step(w, 25);
    expect(bomber.ammo).toBe(1);
  });

  it('the superweapon devastates an area after charging', () => {
    const w = arena('coalition', 'sythari');
    w.players[0].tier = 4;
    const sw = w.addBuilding(0, 'super', 40, 40, true);
    expect(w.fireSuperweapon(0, 50, 50)).toMatch(/charging/i);
    sw.charge = 0;
    const tank = w.spawnUnit(1, 'tank', 52, 50);
    w.players[0].explored.fill(1);
    expect(w.fireSuperweapon(0, 52, 50)).toBe('');
    step(w, 4);
    expect(tank.dead).toBe(true);
  });
});

describe('teams and victory', () => {
  it('a team is out only when every one of its HQs has fallen', () => {
    const setup: MatchSetup = {
      slots: [
        { kind: 'local', faction: 'coalition', team: 0, name: 'A' },
        { kind: 'ai', faction: 'sythari', team: 0, name: 'A2', difficulty: 'easy' },
        { kind: 'ai', faction: 'sythari', team: 1, name: 'B', difficulty: 'easy' },
        { kind: 'marauder', faction: 'marauder', team: -1, name: 'M' },
      ],
      centerOutpost: false,
    };
    const w = createMatch(setup);
    w.collectFx = false;
    w.damage(w.players[0].hq!, 1e7, 'cannon', 2, 0, 0, 0);
    expect(w.players[0].defeated).toBe(true);
    expect(w.over).toBe(false);
    w.damage(w.players[2].hq!, 1e7, 'cannon', 1, 0, 0, 0);
    expect(w.over).toBe(true);
    expect(w.winnerTeam).toBe(0);
    expect(w.won(0)).toBe(true);
  });

  it('allies share vision', () => {
    const setup: MatchSetup = {
      slots: [
        { kind: 'local', faction: 'coalition', team: 0, name: 'A' },
        { kind: 'local', faction: 'sythari', team: 0, name: 'A2' },
        { kind: 'local', faction: 'sythari', team: 1, name: 'B' },
        { kind: 'marauder', faction: 'marauder', team: -1, name: 'M' },
      ],
      centerOutpost: false,
    };
    const w = new World(setup);
    const ally = w.players[1].hq!;
    expect(w.visibleTo(ally, 0)).toBe(true);
    expect(w.visibleTo(w.players[2].hq!, 0)).toBe(false);
  });
});

describe('AI', () => {
  it('two computer players fight a 1v1 to the finish', () => {
    const w = createMatch(duelSetup('coalition', 'sythari', 'normal', 'normal'));
    w.collectFx = false;
    while (!w.over && w.time < 50 * 60) w.update(1 / 30);
    expect(w.over).toBe(true);
    expect([0, 1]).toContain(w.winnerTeam);
  }, 120000);

  it('a 2v2 between computer teams makes progress', () => {
    const setup: MatchSetup = {
      slots: [
        { kind: 'ai', faction: 'coalition', team: 0, name: 'A1', difficulty: 'normal' },
        { kind: 'ai', faction: 'sythari', team: 0, name: 'A2', difficulty: 'normal' },
        { kind: 'ai', faction: 'sythari', team: 1, name: 'B1', difficulty: 'normal' },
        { kind: 'ai', faction: 'coalition', team: 1, name: 'B2', difficulty: 'normal' },
      ],
      centerOutpost: true,
    };
    const w = createMatch(setup);
    w.collectFx = false;
    step(w, 12 * 60);
    for (const p of w.activePlayers) {
      expect(p.stats.unitsBuilt).toBeGreaterThan(8);
      expect(p.tier).toBeGreaterThanOrEqual(2);
    }
    expect(w.activePlayers.reduce((s, p) => s + p.stats.kills, 0)).toBeGreaterThan(5);
  }, 120000);
});

describe('upgrades', () => {
  it('every unit type a faction can build has an upgrade', () => {
    for (const f of ['coalition', 'sythari'] as const) {
      const fac = FACTIONS[f];
      const covered = new Set(Object.values(fac.research).flatMap((r) => r?.units ?? []));
      for (const k of Object.keys(fac.units)) expect(covered.has(k as never), `${f} ${k}`).toBe(true);
      // and every upgrade can be researched somewhere
      for (const r of Object.values(fac.research)) expect(Object.values(fac.buildings).some((b) => b?.research?.includes(r!.key)), r!.key).toBe(true);
    }
  });

  it('optics let snipers see and shoot further', () => {
    const w = arena('coalition', 'sythari');
    const s = w.spawnUnit(0, 'sniper', 44, 48);
    const before = w.sightOf(s);
    w.players[0].researched.add('optics');
    expect(w.sightOf(s)).toBe(before + UPGRADE.optics.sight);
    expect(w.rangeBonus(s)).toBe(UPGRADE.optics.range);
  });

  it('speed loading makes anti-vehicle teams kill tanks faster', () => {
    const time = (upgraded: boolean) => {
      const w = arena('coalition', 'coalition');
      if (upgraded) w.players[0].researched.add('speedload');
      const A = [w.spawnUnit(0, 'rocket', 44, 48), w.spawnUnit(0, 'rocket', 44, 49.5)];
      const tank = w.spawnUnit(1, 'tank', 50, 48.5);
      w.cmdAttack(A, tank);
      let t = 0;
      while (!tank.dead && t < 60) {
        w.update(1 / 30);
        t += 1 / 30;
        tank.order = { type: 'idle' };
        tank.cds[0] = 99; // the tank doesn't fight back
      }
      return t;
    };
    expect(time(true)).toBeLessThan(time(false) * 0.85);
  });

  it('active protection shoots down incoming rockets', () => {
    const w = arena('coalition', 'coalition');
    w.players[1].researched.add('aps');
    const tank = w.spawnUnit(1, 'tank', 50, 48.5);
    const r = w.spawnUnit(0, 'rocket', 45, 48.5);
    w.cmdAttack([r], tank);
    tank.cds[0] = 999;
    step(w, 1.5);
    // the first rocket is intercepted
    expect(tank.hp).toBe(tank.maxHp);
    expect(tank.apsReady).toBeGreaterThan(w.time);
  });

  it('jammers make guided weapons miss aircraft some of the time', () => {
    const hits = (jam: boolean) => {
      const w = arena('coalition', 'coalition');
      if (jam) w.players[1].researched.add('jammer');
      const ship = w.spawnUnit(1, 'gunship', 50, 48);
      const sam = w.addBuilding(0, 'sam', 44, 47, true);
      void sam;
      ship.maxHp = ship.hp = 1e6;
      ship.order = { type: 'idle' };
      step(w, 30);
      return 1e6 - ship.hp;
    };
    const plain = hits(false);
    const jammed = hits(true);
    expect(plain).toBeGreaterThan(0);
    expect(jammed).toBeLessThan(plain * 0.8);
  });

  it('health upgrades apply to new and existing units', () => {
    const w = arena('coalition', 'coalition');
    const jeep = w.spawnUnit(0, 'light', 44, 48);
    const base = jeep.maxHp;
    w.players[0].tier = 2;
    w.players[0].supplies = 5000;
    const factory = w.addBuilding(0, 'factory', 40, 40, true);
    expect(w.queueResearch(factory, 'plating')).toBe('');
    step(w, 40);
    expect(jeep.maxHp).toBeCloseTo(base * UPGRADE.plating.hp);
    expect(w.spawnUnit(0, 'light', 45, 48).maxHp).toBeCloseTo(base * UPGRADE.plating.hp);
  });

  it('upgraded transports carry three squads', () => {
    const w = arena('coalition', 'coalition');
    const apc = w.spawnUnit(0, 'apc', 44, 48);
    expect(w.capacityOf(apc)).toBe(2);
    w.players[0].researched.add('hull');
    expect(w.capacityOf(apc)).toBe(3);
  });

  it('idle builders repair damaged buildings near them', () => {
    const w = arena('coalition', 'coalition');
    const b = w.addBuilding(0, 'barracks', 44, 46, true);
    b.hp = b.maxHp * 0.5;
    w.spawnUnit(0, 'builder', 49, 47);
    step(w, 25);
    expect(b.hp).toBeGreaterThan(b.maxHp * 0.85);
  });
});

describe('fog of war', () => {
  it('the terrain is always known, but enemy units only show in line of sight', () => {
    const w = new World(duelSetup('coalition', 'sythari', null, null, false));
    const p = w.players[0];
    expect(p.explored.every((v) => v === 1)).toBe(true);
    const enemyHq = w.players[2].hq!;
    expect(w.visibleTo(enemyHq, 0)).toBe(false);
  });
});
