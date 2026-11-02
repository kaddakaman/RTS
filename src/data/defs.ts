// All game content: damage rules, factions, units, buildings and upgrades.
//
// Units and buildings share "keys" across factions (e.g. every faction's main
// battle tank is `tank`), so the AI and the UI work the same for any faction.

export type FactionId = 'coalition' | 'sythari' | 'marauder';
export type Armor = 'inf' | 'light' | 'heavy' | 'air' | 'bldg';
export type DmgType = 'small' | 'precision' | 'ap' | 'cannon' | 'bomb' | 'aa' | 'arty';
export type MoveClass = 'foot' | 'wheel' | 'air';
export type Role = 'builder' | 'gatherer' | 'infantry' | 'vehicle' | 'air';
export type FxKind = 'bullet' | 'sniper' | 'laser' | 'rocket' | 'plasma' | 'shell' | 'beam' | 'bomb' | 'missile' | 'arty';
export type AbilityId = 'grenade' | 'recon' | 'boost' | 'unload' | 'build' | 'rearm';

export type UnitKey =
  | 'builder' | 'truck' | 'rifle' | 'sniper' | 'rocket' | 'scout' | 'light' | 'tank' | 'apc' | 'bomber' | 'gunship' | 'dropship'
  | 'raider' | 'rocketeer' | 'technical' | 'junker';
export type BuildingKey =
  | 'hq' | 'barracks' | 'depot' | 'defense' | 'factory' | 'airbase' | 'dropzone' | 'super' | 'sam' | 'arty' | 'bunker'
  | 'fortress' | 'tower';
export type ResearchKey =
  | 'tier2' | 'tier3' | 'tier4'
  | 'medic' | 'optics' | 'speedload' | 'aps' | 'plating' | 'sensors' | 'hull' | 'jammer' | 'cabs' | 'rapid';

/**
 * Rock-paper-scissors: damage multiplier for each damage type against each armour class.
 * 0 means "can't hurt it at all", and the weapon won't target it.
 */
export const DAMAGE_TABLE: Record<DmgType, Record<Armor, number>> = {
  //            infantry  light  heavy  air   buildings
  small:     { inf: 1.0, light: 0.45, heavy: 0.15, air: 0.6, bldg: 0.2 }, // rifles & machine guns: hit anything, weakly
  precision: { inf: 1.0, light: 0, heavy: 0, air: 0, bldg: 0 },            // snipers & beams: infantry only
  ap:        { inf: 0.2, light: 1.4, heavy: 1.6, air: 1.3, bldg: 0.6 },    // rockets & plasma cannons: no splash, punch armour
  cannon:    { inf: 0.6, light: 1.2, heavy: 1.0, air: 0, bldg: 1.0 },      // tank guns
  bomb:      { inf: 0.8, light: 1.2, heavy: 1.2, air: 0, bldg: 1.8 },      // bombs & grenades
  aa:        { inf: 0, light: 0, heavy: 0, air: 1.0, bldg: 0 },            // anti-air missiles
  arty:      { inf: 0.6, light: 1.2, heavy: 1.4, air: 0, bldg: 0.8 },      // artillery shells
};

export const ARMOR_NAMES: Record<Armor, string> = {
  inf: 'Infantry',
  light: 'Light vehicle',
  heavy: 'Heavy vehicle',
  air: 'Aircraft',
  bldg: 'Structure',
};

export interface WeaponDef {
  name: string;
  dmg: DmgType;
  damage: number;
  cooldown: number;
  range: number;
  minRange?: number;
  splash?: number;
  /** Can shoot at aircraft. */
  air?: boolean;
  /** Can shoot at ground targets (default true). */
  ground?: boolean;
  /** Squads: damage is multiplied by the number of members still alive. */
  perMember?: boolean;
  fx: FxKind;
  /** Projectile speed in tiles/second; omitted = instant hit. */
  speed?: number;
  turret?: boolean;
}

export interface UnitDef {
  key: UnitKey;
  faction: FactionId;
  name: string;
  role: Role;
  armor: Armor;
  move: MoveClass;
  /** Health per squad member (or of the whole unit when it isn't a squad). */
  hp: number;
  members?: number;
  speed: number;
  sight: number;
  radius: number;
  cost: number;
  time: number;
  pop: number;
  weapons: WeaponDef[];
  capacity?: number;
  carry?: number;
  loadTime?: number;
  buildRate?: number;
  bomber?: boolean;
  ability?: AbilityId;
  /** General infantry that the field medic upgrade improves. */
  medic?: boolean;
  /** Infantry that can ride transports and man gunner emplacements. */
  infantry?: boolean;
  desc: string;
  strong: string;
  weak: string;
  icon: string;
}

export interface BuildingDef {
  key: BuildingKey;
  faction: FactionId;
  name: string;
  w: number;
  h: number;
  hp: number;
  sight: number;
  cost: number;
  time: number;
  produces?: UnitKey[];
  research?: ResearchKey[];
  weapons?: WeaponDef[];
  /** Supply trucks can unload here. */
  dropoff?: boolean;
  /** Must be built within this many tiles of a supply cache. */
  nearPile?: number;
  freeUnit?: UnitKey;
  garrison?: boolean;
  pads?: number;
  dropZone?: { amount: number; interval: number };
  superweapon?: { charge: number; damage: number; radius: number };
  tier?: number;
  needs?: BuildingKey[];
  max?: number;
  defense?: boolean;
  desc: string;
  icon: string;
}

export interface ResearchDef {
  key: ResearchKey;
  name: string;
  cost: number;
  time: number;
  desc: string;
  needsTier?: number;
  /** Tier the HQ reaches when this upgrade finishes. */
  tier?: number;
  icon: string;
  /** Unit types this upgrade improves. */
  units?: UnitKey[];
}

export interface FactionDef {
  id: FactionId;
  name: string;
  short: string;
  blurb: string;
  units: Partial<Record<UnitKey, UnitDef>>;
  buildings: Partial<Record<BuildingKey, BuildingDef>>;
  research: Partial<Record<ResearchKey, ResearchDef>>;
  /** Order of options in the builder's construction menu. */
  buildMenu: BuildingKey[];
  defenseMenu: BuildingKey[];
  palette: { body: string; dark: string; light: string; accent: string; glow: string };
  dropName: string;
}

/** Population cap for each HQ tier. */
export const POP_CAP = [0, 40, 60, 80, 100];

export const ABILITIES: Record<AbilityId, { name: string; cooldown: number; desc: string }> = {
  grenade: { name: 'Grenade', cooldown: 20, desc: 'Throw a grenade at the nearest enemy in range.' },
  recon: { name: 'Recon Pulse', cooldown: 30, desc: 'Reveal a wide area around the scout for a few seconds.' },
  boost: { name: 'Boost', cooldown: 15, desc: 'A short burst of speed.' },
  unload: { name: 'Unload', cooldown: 0, desc: 'Drop off all passengers.' },
  build: { name: 'Build', cooldown: 0, desc: 'Open the construction menu.' },
  rearm: { name: 'Return to Base', cooldown: 0, desc: 'Fly back to the air base to rearm.' },
};

export const GRENADE = { damage: 70, splash: 1.6, range: 6 };

/** What each unit upgrade does (see world.ts for where they apply). */
export const UPGRADE = {
  /** Snipers / lancers see further and shoot a little further. */
  optics: { sight: 4, range: 1 },
  /** Anti-vehicle teams reload faster: cooldown multiplier. */
  speedload: { reload: 0.65 },
  /** Battle tanks shoot down one incoming rocket or plasma bolt every few seconds. */
  aps: { cooldown: 4 },
  /** Light combat vehicles get more armour: health multiplier. */
  plating: { hp: 1.3 },
  /** Scouts see further and recharge their recon pulse twice as fast. */
  sensors: { sight: 3, recon: 0.5 },
  /** Transports get tougher and carry one more squad. */
  hull: { hp: 1.25, capacity: 1 },
  /** Aircraft: chance that a guided missile, rocket or bolt loses its lock and misses. */
  jammer: { chance: 0.4 },
  /** Supply trucks get tougher. */
  cabs: { hp: 1.5 },
  /** Builders construct and repair faster. */
  rapid: { build: 1.4 },
};
export const RECON = { radius: 15, duration: 8 };
export const BOOST = { mult: 1.8, duration: 3 };

// ---------------------------------------------------------------- helpers

type UnitSpec = Omit<UnitDef, 'key' | 'faction'>;
type BuildingSpec = Omit<BuildingDef, 'key' | 'faction'>;

function units(faction: FactionId, spec: Partial<Record<UnitKey, UnitSpec>>): Partial<Record<UnitKey, UnitDef>> {
  const out: Partial<Record<UnitKey, UnitDef>> = {};
  for (const k of Object.keys(spec) as UnitKey[]) out[k] = { ...(spec[k] as UnitSpec), key: k, faction };
  return out;
}

function buildings(faction: FactionId, spec: Partial<Record<BuildingKey, BuildingSpec>>): Partial<Record<BuildingKey, BuildingDef>> {
  const out: Partial<Record<BuildingKey, BuildingDef>> = {};
  for (const k of Object.keys(spec) as BuildingKey[]) out[k] = { ...(spec[k] as BuildingSpec), key: k, faction };
  return out;
}

/** HQ tiers plus one upgrade for every unit type. */
function research(names: Record<Exclude<ResearchKey, 'tier2' | 'tier3' | 'tier4'>, string> & { tiers: [string, string, string] }): Partial<Record<ResearchKey, ResearchDef>> {
  const t = names.tiers;
  return {
    tier2: { key: 'tier2', name: t[0], cost: 1200, time: 45, tier: 2, icon: 'II', desc: 'HQ Tier 2. Unlocks the vehicle depot, artillery and most unit upgrades. Raises the unit cap.' },
    tier3: { key: 'tier3', name: t[1], cost: 2000, time: 60, tier: 3, needsTier: 2, icon: 'III', desc: 'HQ Tier 3. Unlocks the air base. Raises the unit cap.' },
    tier4: { key: 'tier4', name: t[2], cost: 3000, time: 75, tier: 4, needsTier: 3, icon: 'IV', desc: 'HQ Tier 4. Unlocks the superweapon. Raises the unit cap.' },
    medic: { key: 'medic', name: names.medic, cost: 600, time: 40, needsTier: 2, icon: '+', units: ['rifle'], desc: 'General infantry: adds a medic to every squad, an extra member and passive healing out of combat.' },
    optics: { key: 'optics', name: names.optics, cost: 500, time: 35, needsTier: 2, icon: '◎', units: ['sniper'], desc: `Counter-infantry: +${UPGRADE.optics.sight} vision and +${UPGRADE.optics.range} range, so they spot and shoot first.` },
    speedload: { key: 'speedload', name: names.speedload, cost: 700, time: 40, needsTier: 2, icon: '»', units: ['rocket'], desc: 'Anti-vehicle teams reload about 50% faster, for much more damage per second.' },
    aps: { key: 'aps', name: names.aps, cost: 900, time: 45, icon: '◈', units: ['tank'], desc: `Battle tanks shoot down one incoming rocket or plasma bolt every ${UPGRADE.aps.cooldown} seconds.` },
    plating: { key: 'plating', name: names.plating, cost: 500, time: 35, icon: '▤', units: ['light'], desc: 'Light combat vehicles get 30% more health.' },
    sensors: { key: 'sensors', name: names.sensors, cost: 300, time: 25, icon: '⌖', units: ['scout'], desc: `Scouts get +${UPGRADE.sensors.sight} vision and recharge their recon pulse twice as fast.` },
    hull: { key: 'hull', name: names.hull, cost: 400, time: 30, icon: '▣', units: ['apc'], desc: 'Transports get 25% more health and carry three squads instead of two.' },
    jammer: { key: 'jammer', name: names.jammer, cost: 1000, time: 45, icon: '≋', units: ['gunship', 'bomber', 'dropship'], desc: 'All aircraft: 40% of guided missiles, rockets and plasma bolts fired at them lose their lock and miss.' },
    cabs: { key: 'cabs', name: names.cabs, cost: 300, time: 25, icon: '▥', units: ['truck'], desc: 'Supply trucks get 50% more health.' },
    rapid: { key: 'rapid', name: names.rapid, cost: 400, time: 30, icon: '⚒', units: ['builder'], desc: 'Builders construct and repair 40% faster.' },
  };
}

// ---------------------------------------------------------------- Coalition (human)

const coalition: FactionDef = {
  id: 'coalition',
  name: 'Earth Coalition',
  short: 'Coalition',
  blurb: 'Tough, well-armoured human forces. Slower than the Sythari, but every unit can take a beating.',
  palette: { body: '#6f7a58', dark: '#3c4332', light: '#a3ad84', accent: '#d8d2b4', glow: '#ffd36a' },
  dropName: 'Cargo plane supply drop',
  buildMenu: ['barracks', 'depot', 'defense', 'factory', 'airbase', 'dropzone', 'super'],
  defenseMenu: ['bunker', 'sam', 'arty'],
  units: units('coalition', {
    builder: {
      name: 'Engineer Dozer', role: 'builder', armor: 'light', move: 'wheel', hp: 450, speed: 3.0, sight: 7, radius: 0.55,
      cost: 250, time: 12, pop: 1, weapons: [], buildRate: 1, ability: 'build', icon: 'DZ',
      desc: 'Builds and repairs structures.', strong: '-', weak: 'Everything - keep it safe',
    },
    truck: {
      name: 'Supply Truck', role: 'gatherer', armor: 'light', move: 'wheel', hp: 320, speed: 3.6, sight: 6, radius: 0.5,
      cost: 300, time: 14, pop: 1, weapons: [], carry: 40, loadTime: 4.5, icon: 'TR',
      desc: 'Hauls supplies from caches to your HQ or a supply depot.', strong: '-', weak: 'Everything',
    },
    rifle: {
      name: 'Rifle Squad', role: 'infantry', armor: 'inf', move: 'foot', hp: 60, members: 5, speed: 2.2, sight: 8, radius: 0.6,
      cost: 200, time: 14, pop: 2, ability: 'grenade', medic: true, infantry: true, icon: 'RF',
      weapons: [{ name: 'Assault rifles', dmg: 'small', damage: 5, cooldown: 1.0, range: 5, air: true, perMember: true, fx: 'bullet' }],
      desc: 'Five riflemen. Shoots at anything, but only scratches armour.', strong: 'Aircraft (a little), all-rounder', weak: 'Snipers, tanks, light vehicles',
    },
    sniper: {
      name: 'Sniper Team', role: 'infantry', armor: 'inf', move: 'foot', hp: 75, members: 2, speed: 2.1, sight: 12, radius: 0.45,
      cost: 300, time: 16, pop: 2, infantry: true, icon: 'SN',
      weapons: [{ name: 'Sniper rifle', dmg: 'precision', damage: 140, cooldown: 2.0, range: 10, fx: 'sniper' }],
      desc: 'A sniper and a spotter. Picks off infantry from long range. Cannot attack vehicles, aircraft or buildings.', strong: 'Infantry', weak: 'Vehicles, aircraft',
    },
    rocket: {
      name: 'Rocket Team', role: 'infantry', armor: 'inf', move: 'foot', hp: 70, members: 2, speed: 2.0, sight: 8, radius: 0.45,
      cost: 300, time: 16, pop: 2, infantry: true, icon: 'RK',
      weapons: [{ name: 'Rocket launcher', dmg: 'ap', damage: 100, cooldown: 3.0, range: 7, air: true, fx: 'rocket', speed: 12 }],
      desc: 'A gunner and a loader. Armour-piercing rockets wreck vehicles and aircraft but barely hurt infantry.', strong: 'Tanks, vehicles, aircraft', weak: 'Infantry, light vehicles up close',
    },
    scout: {
      name: 'Pathfinder Scout', role: 'vehicle', armor: 'light', move: 'wheel', hp: 200, speed: 6.0, sight: 13, radius: 0.5,
      cost: 150, time: 10, pop: 1, weapons: [], ability: 'recon', icon: 'SC',
      desc: 'Unarmed, very fast, sees far. Use it to scout through the fog of war.', strong: 'Intel', weak: 'Everything',
    },
    light: {
      name: 'Hound Gun Jeep', role: 'vehicle', armor: 'light', move: 'wheel', hp: 400, speed: 4.3, sight: 9, radius: 0.6,
      cost: 400, time: 18, pop: 2, ability: 'boost', icon: 'LV',
      weapons: [{ name: 'Machine gun', dmg: 'small', damage: 9, cooldown: 0.3, range: 6, air: true, turret: true, fx: 'bullet' }],
      desc: 'Fast light combat vehicle with a machine gun that can also shoot at aircraft.', strong: 'Infantry, rocket teams', weak: 'Tanks, rocket teams at range',
    },
    tank: {
      name: 'Bulwark Battle Tank', role: 'vehicle', armor: 'heavy', move: 'wheel', hp: 1100, speed: 2.6, sight: 9, radius: 0.75,
      cost: 750, time: 28, pop: 4, icon: 'TK',
      weapons: [{ name: 'Main gun', dmg: 'cannon', damage: 75, cooldown: 2.2, range: 7, splash: 0.9, turret: true, fx: 'shell', speed: 20 }],
      desc: 'Main battle tank. Heavy armour and a cannon that is good against everything on the ground.', strong: 'Infantry, vehicles, buildings', weak: 'Rocket teams, gunships, bombers',
    },
    apc: {
      name: 'Mule Transport', role: 'vehicle', armor: 'light', move: 'wheel', hp: 550, speed: 4.6, sight: 8, radius: 0.65,
      cost: 300, time: 16, pop: 1, weapons: [], capacity: 2, ability: 'unload', icon: 'AP',
      desc: 'Unarmed truck that carries two infantry squads across the map quickly.', strong: 'Moving infantry', weak: 'Everything',
    },
    bomber: {
      name: 'Hammerhead Bomber', role: 'air', armor: 'air', move: 'air', hp: 420, speed: 9, sight: 8, radius: 0.7,
      cost: 900, time: 30, pop: 4, bomber: true, ability: 'rearm', icon: 'BM',
      weapons: [{ name: 'Bomb load', dmg: 'bomb', damage: 220, cooldown: 0, range: 0.8, splash: 2.2, fx: 'bomb' }],
      desc: 'Fast jet. Flies one bombing run, then must return to an air base to reload.', strong: 'Buildings, vehicles', weak: 'SAM sites, rocket teams',
    },
    gunship: {
      name: 'Hornet Gunship', role: 'air', armor: 'air', move: 'air', hp: 650, speed: 4.8, sight: 9, radius: 0.75,
      cost: 1000, time: 32, pop: 4, icon: 'GS',
      weapons: [
        { name: 'Rocket pods', dmg: 'ap', damage: 40, cooldown: 1.6, range: 6, fx: 'rocket', speed: 14 },
        { name: 'Chain gun', dmg: 'small', damage: 7, cooldown: 0.25, range: 5.5, fx: 'bullet' },
      ],
      desc: 'Attack helicopter that stays in the air. Shreds vehicles. Cannot attack aircraft.', strong: 'Vehicles, infantry', weak: 'SAM sites, rocket teams',
    },
    dropship: {
      name: 'Albatross Dropship', role: 'air', armor: 'air', move: 'air', hp: 600, speed: 6.5, sight: 9, radius: 0.85,
      cost: 600, time: 24, pop: 2, weapons: [], capacity: 2, ability: 'unload', icon: 'DS',
      desc: 'Unarmed twin-rotor transport. Carries two infantry squads over cliffs, water and chokepoints, and drops them anywhere. If it is shot down, everyone aboard is lost.',
      strong: 'Drops behind enemy lines', weak: 'Anti-air',
    },
  }),
  buildings: buildings('coalition', {
    hq: {
      name: 'Command Center', w: 4, h: 4, hp: 6000, sight: 10, cost: 0, time: 1, produces: ['builder'], research: ['tier2', 'tier3', 'tier4', 'rapid'],
      dropoff: true, icon: 'HQ',
      weapons: [{ name: 'Defence gun', dmg: 'small', damage: 12, cooldown: 0.5, range: 7, air: true, turret: true, fx: 'bullet' }],
      desc: 'Your headquarters. If it is destroyed, you lose. Builds dozers and upgrades your tech tier.',
    },
    barracks: { name: 'Barracks', w: 3, h: 3, hp: 1500, sight: 8, cost: 500, time: 25, produces: ['rifle', 'sniper', 'rocket'], research: ['medic', 'optics', 'speedload'], icon: 'BK', desc: 'Trains infantry squads.' },
    depot: {
      name: 'Supply Depot', w: 3, h: 3, hp: 1300, sight: 8, cost: 600, time: 25, produces: ['truck'], research: ['cabs'], dropoff: true, nearPile: 8, freeUnit: 'truck', icon: 'SD',
      desc: 'Must be built near a supply cache. Comes with a free supply truck and builds more.',
    },
    defense: { name: 'Fortifications Yard', w: 3, h: 3, hp: 1300, sight: 8, cost: 600, time: 25, needs: ['barracks'], icon: 'FY', desc: 'Lets your dozers build gunner emplacements, SAM sites and howitzers.' },
    factory: { name: 'Vehicle Depot', w: 4, h: 4, hp: 2200, sight: 8, cost: 1000, time: 35, tier: 2, produces: ['scout', 'light', 'tank', 'apc'], research: ['aps', 'plating', 'sensors', 'hull'], icon: 'VD', desc: 'Builds vehicles. Requires HQ Tier 2.' },
    airbase: { name: 'Air Base', w: 4, h: 4, hp: 2000, sight: 9, cost: 1400, time: 40, tier: 3, produces: ['gunship', 'bomber', 'dropship'], research: ['jammer'], pads: 2, icon: 'AB', desc: 'Builds aircraft and rearms bombers. Requires HQ Tier 3.' },
    dropzone: {
      name: 'Supply Drop Zone', w: 3, h: 3, hp: 1000, sight: 7, cost: 1500, time: 30, needs: ['depot'], max: 3, dropZone: { amount: 300, interval: 45 }, icon: 'DZ',
      desc: 'A cargo plane air-drops 300 supplies here every 45 seconds, forever. Build it before the caches run dry.',
    },
    super: {
      name: 'Orbital Strike Uplink', w: 4, h: 4, hp: 3000, sight: 8, cost: 3500, time: 60, tier: 4, max: 1, superweapon: { charge: 240, damage: 2600, radius: 5 }, icon: 'OS',
      desc: 'Superweapon. Calls down an orbital bombardment anywhere you can see. Recharges in 4 minutes.',
    },
    sam: {
      name: 'SAM Site', w: 2, h: 2, hp: 800, sight: 10, cost: 500, time: 20, needs: ['defense'], defense: true, icon: 'SA',
      weapons: [{ name: 'SAM missiles', dmg: 'aa', damage: 60, cooldown: 1.5, range: 10, air: true, ground: false, fx: 'missile', speed: 16, turret: true }],
      desc: 'Anti-air defence. Only shoots at aircraft.',
    },
    arty: {
      name: 'Howitzer', w: 2, h: 2, hp: 900, sight: 8, cost: 800, time: 30, needs: ['defense'], tier: 2, defense: true, icon: 'HW',
      weapons: [{ name: 'Howitzer shells', dmg: 'arty', damage: 110, cooldown: 4, range: 16, minRange: 4, splash: 1.2, turret: true, fx: 'arty', speed: 11 }],
      desc: 'Long-range artillery, deadly to vehicles. Needs something else to spot targets far away.',
    },
    bunker: {
      name: 'Gunner Emplacement', w: 2, h: 2, hp: 1200, sight: 9, cost: 400, time: 20, needs: ['defense'], garrison: true, defense: true, icon: 'GE',
      desc: 'Send an infantry squad inside: it deals 50% more damage, gains range and takes far less damage.',
    },
  }),
  research: research({
    tiers: ['HQ Tier 2', 'HQ Tier 3', 'HQ Tier 4'],
    medic: 'Field Medics',
    optics: 'Spotter Optics',
    speedload: 'Speed Loading',
    aps: 'Active Protection',
    plating: 'Composite Plating',
    sensors: 'Long-Range Sensors',
    hull: 'Reinforced Hull',
    jammer: 'ECM Jammers',
    cabs: 'Armoured Cabs',
    rapid: 'Rapid Construction',
  }),
};

// ---------------------------------------------------------------- Sythari (alien)

const sythari: FactionDef = {
  id: 'sythari',
  name: 'Sythari Ascendancy',
  short: 'Sythari',
  blurb: 'Fast alien raiders with devastating plasma and beam weapons, but thinner armour.',
  palette: { body: '#5d4b7d', dark: '#2c2340', light: '#9a86c4', accent: '#d9cff2', glow: '#4ff0dc' },
  dropName: 'Teleported supplies',
  buildMenu: ['barracks', 'depot', 'defense', 'factory', 'airbase', 'dropzone', 'super'],
  defenseMenu: ['bunker', 'sam', 'arty'],
  units: units('sythari', {
    builder: {
      name: 'Shaper Drone', role: 'builder', armor: 'light', move: 'wheel', hp: 360, speed: 3.6, sight: 7, radius: 0.5,
      cost: 250, time: 12, pop: 1, weapons: [], buildRate: 1, ability: 'build', icon: 'SH',
      desc: 'Grows and mends structures.', strong: '-', weak: 'Everything - keep it safe',
    },
    truck: {
      name: 'Harvester Drone', role: 'gatherer', armor: 'light', move: 'wheel', hp: 260, speed: 4.0, sight: 6, radius: 0.48,
      cost: 300, time: 14, pop: 1, weapons: [], carry: 40, loadTime: 4.5, icon: 'HV',
      desc: 'Siphons supplies from caches to your Nexus or a siphon node.', strong: '-', weak: 'Everything',
    },
    rifle: {
      name: 'Vanguard Strikers', role: 'infantry', armor: 'inf', move: 'foot', hp: 44, members: 5, speed: 2.8, sight: 8, radius: 0.6,
      cost: 200, time: 14, pop: 2, ability: 'grenade', medic: true, infantry: true, icon: 'VS',
      weapons: [{ name: 'Plasma carbines', dmg: 'small', damage: 6.7, cooldown: 1.0, range: 5, air: true, perMember: true, fx: 'laser' }],
      desc: 'Five alien warriors: faster and harder-hitting than human riflemen, but frailer.', strong: 'Aircraft (a little), all-rounder', weak: 'Beam lancers, tanks, light vehicles',
    },
    sniper: {
      name: 'Beam Lancers', role: 'infantry', armor: 'inf', move: 'foot', hp: 55, members: 2, speed: 2.6, sight: 12, radius: 0.45,
      cost: 300, time: 16, pop: 2, infantry: true, icon: 'BL',
      weapons: [{ name: 'Lance beam', dmg: 'precision', damage: 105, cooldown: 1.1, range: 9.5, fx: 'beam' }],
      desc: 'A lancer and a seer. Their beam burns through infantry. Cannot attack vehicles, aircraft or buildings.', strong: 'Infantry', weak: 'Vehicles, aircraft',
    },
    rocket: {
      name: 'Plasma Cannon Team', role: 'infantry', armor: 'inf', move: 'foot', hp: 52, members: 2, speed: 2.5, sight: 8, radius: 0.45,
      cost: 300, time: 16, pop: 2, infantry: true, icon: 'PC',
      weapons: [{ name: 'Plasma cannon', dmg: 'ap', damage: 125, cooldown: 2.8, range: 7, air: true, fx: 'plasma', speed: 13 }],
      desc: 'A gunner and a charger. Plasma bolts melt vehicles and aircraft but barely hurt infantry.', strong: 'Tanks, vehicles, aircraft', weak: 'Infantry, light vehicles up close',
    },
    scout: {
      name: 'Seeker Skiff', role: 'vehicle', armor: 'light', move: 'wheel', hp: 150, speed: 7.0, sight: 13, radius: 0.48,
      cost: 150, time: 10, pop: 1, weapons: [], ability: 'recon', icon: 'SK',
      desc: 'Unarmed hover skiff. Extremely fast, sees far.', strong: 'Intel', weak: 'Everything',
    },
    light: {
      name: 'Glaive Skimmer', role: 'vehicle', armor: 'light', move: 'wheel', hp: 320, speed: 5.0, sight: 9, radius: 0.58,
      cost: 400, time: 18, pop: 2, ability: 'boost', icon: 'GL',
      weapons: [{ name: 'Pulse repeater', dmg: 'small', damage: 11, cooldown: 0.3, range: 6, air: true, turret: true, fx: 'laser' }],
      desc: 'Fast hover skimmer with a rapid pulse gun that can also hit aircraft.', strong: 'Infantry, plasma teams', weak: 'Tanks, plasma teams at range',
    },
    tank: {
      name: 'Tremor Grav-Tank', role: 'vehicle', armor: 'heavy', move: 'wheel', hp: 900, speed: 3.1, sight: 9, radius: 0.72,
      cost: 750, time: 28, pop: 4, icon: 'GT',
      weapons: [{ name: 'Fusion lance', dmg: 'cannon', damage: 85, cooldown: 2.05, range: 7, splash: 0.9, turret: true, fx: 'plasma', speed: 22 }],
      desc: 'Hovering battle tank. Hits harder and moves faster than the Bulwark, with less armour.', strong: 'Infantry, vehicles, buildings', weak: 'Plasma teams, hovercraft, bombers',
    },
    apc: {
      name: 'Phase Carrier', role: 'vehicle', armor: 'light', move: 'wheel', hp: 450, speed: 5.2, sight: 8, radius: 0.62,
      cost: 300, time: 16, pop: 1, weapons: [], capacity: 2, ability: 'unload', icon: 'CR',
      desc: 'Unarmed hover carrier that moves two infantry squads quickly.', strong: 'Moving infantry', weak: 'Everything',
    },
    bomber: {
      name: 'Talon Striker', role: 'air', armor: 'air', move: 'air', hp: 340, speed: 10.5, sight: 8, radius: 0.65,
      cost: 900, time: 30, pop: 4, bomber: true, ability: 'rearm', icon: 'TS',
      weapons: [{ name: 'Plasma bombs', dmg: 'bomb', damage: 260, cooldown: 0, range: 0.8, splash: 2.2, fx: 'bomb' }],
      desc: 'Very fast strike craft. One bombing run, then it returns to the skyhive to recharge.', strong: 'Buildings, vehicles', weak: 'Disruptor spires, plasma teams',
    },
    gunship: {
      name: 'Shrike Hovercraft', role: 'air', armor: 'air', move: 'air', hp: 540, speed: 5.4, sight: 9, radius: 0.72,
      cost: 1000, time: 32, pop: 4, icon: 'SR',
      weapons: [
        { name: 'Plasma lances', dmg: 'ap', damage: 48, cooldown: 1.6, range: 6, fx: 'plasma', speed: 15 },
        { name: 'Pulse cannon', dmg: 'small', damage: 8.4, cooldown: 0.25, range: 5.5, fx: 'laser' },
      ],
      desc: 'Hovering attack craft that stays aloft. Shreds vehicles. Cannot attack aircraft.', strong: 'Vehicles, infantry', weak: 'Disruptor spires, plasma teams',
    },
    dropship: {
      name: 'Veil Lifter', role: 'air', armor: 'air', move: 'air', hp: 480, speed: 7.5, sight: 9, radius: 0.8,
      cost: 600, time: 24, pop: 2, weapons: [], capacity: 2, ability: 'unload', icon: 'VL',
      desc: 'Unarmed phase-lifter. Carries two infantry squads over cliffs, water and chokepoints, and drops them anywhere. If it is shot down, everyone aboard is lost.',
      strong: 'Drops behind enemy lines', weak: 'Anti-air',
    },
  }),
  buildings: buildings('sythari', {
    hq: {
      name: 'Nexus Spire', w: 4, h: 4, hp: 6000, sight: 10, cost: 0, time: 1, produces: ['builder'], research: ['tier2', 'tier3', 'tier4', 'rapid'],
      dropoff: true, icon: 'NX',
      weapons: [{ name: 'Spire pulse', dmg: 'small', damage: 12, cooldown: 0.5, range: 7, air: true, turret: true, fx: 'laser' }],
      desc: 'Your headquarters. If it is destroyed, you lose. Grows shaper drones and ascends your tech tier.',
    },
    barracks: { name: 'Warrior Sanctum', w: 3, h: 3, hp: 1500, sight: 8, cost: 500, time: 25, produces: ['rifle', 'sniper', 'rocket'], research: ['medic', 'optics', 'speedload'], icon: 'WS', desc: 'Births infantry squads.' },
    depot: {
      name: 'Siphon Node', w: 3, h: 3, hp: 1300, sight: 8, cost: 600, time: 25, produces: ['truck'], research: ['cabs'], dropoff: true, nearPile: 8, freeUnit: 'truck', icon: 'SN',
      desc: 'Must be built near a supply cache. Comes with a free harvester drone and grows more.',
    },
    defense: { name: 'Bastion Forge', w: 3, h: 3, hp: 1300, sight: 8, cost: 600, time: 25, needs: ['barracks'], icon: 'BF', desc: 'Lets your shapers grow bastion pods, disruptor spires and siege obelisks.' },
    factory: { name: 'Grav Foundry', w: 4, h: 4, hp: 2200, sight: 8, cost: 1000, time: 35, tier: 2, produces: ['scout', 'light', 'tank', 'apc'], research: ['aps', 'plating', 'sensors', 'hull'], icon: 'GF', desc: 'Builds hover vehicles. Requires Nexus Tier 2.' },
    airbase: { name: 'Skyhive', w: 4, h: 4, hp: 2000, sight: 9, cost: 1400, time: 40, tier: 3, produces: ['gunship', 'bomber', 'dropship'], research: ['jammer'], pads: 2, icon: 'SY', desc: 'Builds aircraft and recharges strikers. Requires Nexus Tier 3.' },
    dropzone: {
      name: 'Teleport Beacon', w: 3, h: 3, hp: 1000, sight: 7, cost: 1500, time: 30, needs: ['depot'], max: 3, dropZone: { amount: 300, interval: 45 }, icon: 'TB',
      desc: 'Supplies are teleported down here from orbit: 300 every 45 seconds, forever.',
    },
    super: {
      name: 'Singularity Lance', w: 4, h: 4, hp: 3000, sight: 8, cost: 3500, time: 60, tier: 4, max: 1, superweapon: { charge: 240, damage: 2600, radius: 5 }, icon: 'SL',
      desc: 'Superweapon. Tears open a singularity anywhere you can see. Recharges in 4 minutes.',
    },
    sam: {
      name: 'Disruptor Spire', w: 2, h: 2, hp: 750, sight: 10, cost: 500, time: 20, needs: ['defense'], defense: true, icon: 'DS',
      weapons: [{ name: 'Disruptor bolts', dmg: 'aa', damage: 66, cooldown: 1.5, range: 10, air: true, ground: false, fx: 'missile', speed: 18, turret: true }],
      desc: 'Anti-air defence. Only shoots at aircraft.',
    },
    arty: {
      name: 'Siege Obelisk', w: 2, h: 2, hp: 820, sight: 8, cost: 800, time: 30, needs: ['defense'], tier: 2, defense: true, icon: 'SO',
      weapons: [{ name: 'Gravity mortar', dmg: 'arty', damage: 120, cooldown: 4, range: 16, minRange: 4, splash: 1.2, turret: true, fx: 'arty', speed: 12 }],
      desc: 'Long-range artillery, deadly to vehicles. Needs something else to spot targets far away.',
    },
    bunker: {
      name: 'Bastion Pod', w: 2, h: 2, hp: 1100, sight: 9, cost: 400, time: 20, needs: ['defense'], garrison: true, defense: true, icon: 'BP',
      desc: 'Send an infantry squad inside: it deals 50% more damage, gains range and takes far less damage.',
    },
  }),
  research: research({
    tiers: ['Nexus Ascension II', 'Nexus Ascension III', 'Nexus Ascension IV'],
    medic: 'Mender Symbionts',
    optics: 'Seer Link',
    speedload: 'Plasma Capacitors',
    aps: 'Phase Deflector',
    plating: 'Hardened Carapace',
    sensors: 'Deep Scanners',
    hull: 'Expanded Hold',
    jammer: 'Signal Scramblers',
    cabs: 'Chitin Shells',
    rapid: 'Rapid Shaping',
  }),
};

// ---------------------------------------------------------------- Marauders (neutral)

const marauder: FactionDef = {
  id: 'marauder',
  name: 'Marauders',
  short: 'Marauders',
  blurb: 'Scavengers sitting on the biggest supply hoard on the map. They attack anyone who enters their territory, and strike back hard if provoked.',
  palette: { body: '#7f6243', dark: '#3d2e20', light: '#b08d5e', accent: '#e8d3a8', glow: '#ff9a3c' },
  dropName: '',
  buildMenu: [],
  defenseMenu: [],
  units: units('marauder', {
    raider: {
      name: 'Raider Gang', role: 'infantry', armor: 'inf', move: 'foot', hp: 55, members: 4, speed: 2.3, sight: 8, radius: 0.55,
      cost: 0, time: 0, pop: 0, infantry: true, icon: 'RG',
      weapons: [{ name: 'Scrap rifles', dmg: 'small', damage: 6, cooldown: 1.0, range: 5, air: true, perMember: true, fx: 'bullet' }],
      desc: 'Marauder gunmen.', strong: '-', weak: '-',
    },
    rocketeer: {
      name: 'Rocketeers', role: 'infantry', armor: 'inf', move: 'foot', hp: 60, members: 2, speed: 2.1, sight: 8, radius: 0.45,
      cost: 0, time: 0, pop: 0, infantry: true, icon: 'RT',
      weapons: [{ name: 'Junk rockets', dmg: 'ap', damage: 90, cooldown: 3.2, range: 7, air: true, fx: 'rocket', speed: 11 }],
      desc: 'Marauder rocket team.', strong: '-', weak: '-',
    },
    technical: {
      name: 'Technical', role: 'vehicle', armor: 'light', move: 'wheel', hp: 380, speed: 4.4, sight: 9, radius: 0.6,
      cost: 0, time: 0, pop: 0, icon: 'TC',
      weapons: [{ name: 'Mounted gun', dmg: 'small', damage: 9, cooldown: 0.32, range: 6, air: true, turret: true, fx: 'bullet' }],
      desc: 'Pickup truck with a machine gun.', strong: '-', weak: '-',
    },
    junker: {
      name: 'Junker Tank', role: 'vehicle', armor: 'heavy', move: 'wheel', hp: 1000, speed: 2.4, sight: 9, radius: 0.75,
      cost: 0, time: 0, pop: 0, icon: 'JK',
      weapons: [{ name: 'Scrap cannon', dmg: 'cannon', damage: 70, cooldown: 2.4, range: 7, splash: 0.8, turret: true, fx: 'shell', speed: 18 }],
      desc: 'A tank welded together from wrecks.', strong: '-', weak: '-',
    },
  }),
  buildings: buildings('marauder', {
    fortress: {
      name: 'Marauder Stronghold', w: 4, h: 4, hp: 6000, sight: 10, cost: 0, time: 1, icon: 'MS',
      weapons: [
        { name: 'Heavy guns', dmg: 'small', damage: 14, cooldown: 0.4, range: 8, air: true, turret: true, fx: 'bullet' },
        { name: 'Wall cannon', dmg: 'cannon', damage: 70, cooldown: 3, range: 8, splash: 0.8, fx: 'shell', speed: 18 },
      ],
      desc: 'Destroy it to end the Marauder threat and claim a bounty.',
    },
    tower: {
      name: 'Gun Tower', w: 2, h: 2, hp: 1500, sight: 9, cost: 0, time: 1, icon: 'GT', defense: true,
      weapons: [{ name: 'Tower gun', dmg: 'small', damage: 10, cooldown: 0.35, range: 7, air: true, turret: true, fx: 'bullet' }],
      desc: 'Marauder watchtower.',
    },
  }),
  research: {},
};

export const FACTIONS: Record<FactionId, FactionDef> = { coalition, sythari, marauder };
export const PLAYABLE: FactionId[] = ['coalition', 'sythari'];

export function unitDef(f: FactionId, k: UnitKey): UnitDef {
  const d = FACTIONS[f].units[k];
  if (!d) throw new Error(`No unit ${k} for ${f}`);
  return d;
}

export function buildingDef(f: FactionId, k: BuildingKey): BuildingDef {
  const d = FACTIONS[f].buildings[k];
  if (!d) throw new Error(`No building ${k} for ${f}`);
  return d;
}

export function researchDef(f: FactionId, k: ResearchKey): ResearchDef {
  const d = FACTIONS[f].research[k];
  if (!d) throw new Error(`No research ${k} for ${f}`);
  return d;
}

export function damageMult(dmg: DmgType, armor: Armor): number {
  return DAMAGE_TABLE[dmg][armor];
}

/** Can this weapon shoot at something with this armour? */
export function weaponCanHit(w: WeaponDef, armor: Armor): boolean {
  if (armor === 'air') return !!w.air && damageMult(w.dmg, armor) > 0;
  if (w.ground === false) return false;
  return damageMult(w.dmg, armor) > 0;
}

/** Colour of each base slot (index 4 = Marauders). */
export const TEAM_COLORS = ['#3d9bff', '#3fd46a', '#ff4b4b', '#ffd23d', '#ff7a1a'];
export const SLOT_NAMES = ['Blue', 'Green', 'Red', 'Yellow', 'Marauders'];

/** Bounty paid to whoever destroys the Marauder stronghold. */
export const FORTRESS_BOUNTY = 1500;
export const STARTING_SUPPLIES = 1500;
