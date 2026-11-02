// Rock-paper-scissors: each counter should reliably beat what it counters,
// at roughly equal cost.
import { beforeEach, describe, expect, it } from 'vitest';
import { DAMAGE_TABLE, FACTIONS, weaponCanHit } from '../src/data/defs';
import { seedRandom, winsA } from './helpers';

beforeEach(() => seedRandom(12345));

describe('damage rules', () => {
  it('counter-infantry can only shoot infantry', () => {
    for (const f of ['coalition', 'sythari'] as const) {
      const w = FACTIONS[f].units.sniper!.weapons[0];
      expect(weaponCanHit(w, 'inf')).toBe(true);
      expect(weaponCanHit(w, 'light')).toBe(false);
      expect(weaponCanHit(w, 'heavy')).toBe(false);
      expect(weaponCanHit(w, 'air')).toBe(false);
      expect(weaponCanHit(w, 'bldg')).toBe(false);
    }
  });
  it('general infantry can shoot everything, weakly against armour', () => {
    const w = FACTIONS.coalition.units.rifle!.weapons[0];
    for (const a of ['inf', 'light', 'heavy', 'air', 'bldg'] as const) expect(weaponCanHit(w, a)).toBe(true);
    expect(DAMAGE_TABLE.small.heavy).toBeLessThan(0.3);
  });
  it('anti-vehicle weapons punch armour but barely hurt infantry, with no splash', () => {
    expect(DAMAGE_TABLE.ap.heavy).toBeGreaterThan(1.4);
    expect(DAMAGE_TABLE.ap.air).toBeGreaterThan(1);
    expect(DAMAGE_TABLE.ap.inf).toBeLessThan(0.3);
    for (const f of ['coalition', 'sythari'] as const) expect(FACTIONS[f].units.rocket!.weapons[0].splash ?? 0).toBe(0);
  });
  it('scouts and transports are unarmed', () => {
    for (const f of ['coalition', 'sythari'] as const)
      for (const k of ['scout', 'apc', 'dropship'] as const) expect(FACTIONS[f].units[k]!.weapons.length).toBe(0);
  });
  it('aliens are faster and hit harder but have less health than humans', () => {
    const c = FACTIONS.coalition.units.rifle!;
    const s = FACTIONS.sythari.units.rifle!;
    expect(s.speed).toBeGreaterThan(c.speed);
    expect(s.hp).toBeLessThan(c.hp);
    expect(s.weapons[0].damage).toBeGreaterThan(c.weapons[0].damage);
  });
});

describe('counters win fights', () => {
  it('snipers beat rifle squads', () => {
    expect(winsA(3, ['sniper', 'sniper'], ['rifle', 'rifle', 'rifle'])).toBeGreaterThanOrEqual(2);
  });
  it('tanks beat rifle squads', () => {
    expect(winsA(3, ['tank'], ['rifle', 'rifle', 'rifle', 'rifle'])).toBeGreaterThanOrEqual(2);
  });
  it('rocket teams beat a tank', () => {
    expect(winsA(3, ['rocket', 'rocket', 'rocket'], ['tank'])).toBeGreaterThanOrEqual(2);
  });
  it('light vehicles beat infantry', () => {
    expect(winsA(3, ['light'], ['rifle', 'rifle'])).toBeGreaterThanOrEqual(2);
    expect(winsA(3, ['light'], ['rocket'])).toBeGreaterThanOrEqual(2);
  });
  it('gunships beat tanks but lose to rocket teams and SAM sites', () => {
    expect(winsA(3, ['gunship'], ['tank'])).toBeGreaterThanOrEqual(2);
    expect(winsA(3, ['gunship'], ['rocket', 'rocket', 'rocket'])).toBeLessThanOrEqual(1);
    expect(winsA(2, ['gunship'], [], 'coalition', 'coalition', 'sam')).toBe(0);
  });
  it('equal human and alien armies trade evenly', () => {
    // over several fights each side should win some
    let c = 0;
    for (const n of [1, 2, 3, 4]) c += winsA(4, Array(n).fill('rifle'), Array(n).fill('rifle'), 'coalition', 'sythari');
    expect(c).toBeGreaterThanOrEqual(4);
    expect(c).toBeLessThanOrEqual(12);
  });
});
