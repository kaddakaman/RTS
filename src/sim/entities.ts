// Things that live on the battlefield: units (including infantry squads),
// buildings and supply caches.

import type { BuildingDef, BuildingKey, DmgType, FactionId, FxKind, ResearchKey, UnitDef, UnitKey } from '../data/defs';
import type { FlowField } from './paths';

export type Order =
  | { type: 'idle' }
  | { type: 'move'; x: number; y: number; attackMove: boolean; gx: number; gy: number }
  | { type: 'attack'; target: number }
  | { type: 'attackGround'; x: number; y: number }
  | { type: 'gather'; pile: number }
  | { type: 'build'; target: number }
  | { type: 'enter'; target: number }
  | { type: 'rearm' };

export type GatherState = 'toPile' | 'loading' | 'toDepot' | 'unloading';

export class Unit {
  readonly kind = 'unit' as const;
  angle = 0;
  turret = 0;
  hp: number;
  maxHp: number;
  dead = false;
  order: Order = { type: 'idle' };
  anchorX: number;
  anchorY: number;

  // movement
  goalX = 0;
  goalY = 0;
  hasGoal = false;
  field: FlowField | null = null;
  steerX = 0;
  steerY = 0;
  steerT = 0;
  stuckT = 0;
  stuckCount = 0;
  progressX = 0;
  progressY = 0;
  moving = false;
  boostT = 0;
  arrive = 0.25;

  // combat
  cds: number[];
  target: Entity | null = null;
  scanT = 0;
  chase: Entity | null = null;
  lastHurtT = -99;
  lastFireT = -99;
  fireAnim = 0;
  abilityCd = 0;
  kills = 0;

  // squads
  members: number;
  memberHp: number;
  medic = false;

  // supply trucks
  cargo = 0;
  gState: GatherState = 'toPile';
  gTimer = 0;
  loadingPile = 0;

  // transports and garrisons
  passengers: Unit[] = [];
  container = 0;

  // bombers
  ammo = 1;
  rearmT = 0;

  /** Neutral units: only fight inside their territory unless sent on a raid. */
  territorial = false;
  /** Client-side interpolation targets (network play). */
  nx = 0;
  ny = 0;
  px = 0;
  py = 0;
  raidUntil = 0;
  /** For neutral targets: until when each player may freely shoot back at it. */
  hostileTo = [0, 0, 0, 0, 0];
  /** Marauder camp this belongs to (-1 = none). */
  camp = -1;

  constructor(
    readonly id: number,
    readonly owner: number,
    readonly faction: FactionId,
    readonly key: UnitKey,
    readonly def: UnitDef,
    public x: number,
    public y: number,
  ) {
    this.members = def.members ?? 1;
    this.memberHp = def.hp;
    this.maxHp = def.hp * this.members;
    this.hp = this.maxHp;
    this.cds = def.weapons.map(() => Math.random() * 0.5);
    this.anchorX = x;
    this.anchorY = y;
  }

  get radius(): number {
    return this.def.radius;
  }

  get air(): boolean {
    return this.def.move === 'air';
  }

  get armor() {
    return this.def.armor;
  }

  /** Squad members still standing. */
  get alive(): number {
    if (!this.def.members) return 1;
    return Math.max(0, Math.min(this.members, Math.ceil(this.hp / this.memberHp - 1e-6)));
  }

  /** Members that shoot (the medic doesn't). */
  get shooters(): number {
    const a = this.alive;
    return this.medic ? Math.max(1, Math.min(a, this.members - 1)) : a;
  }

  get inside(): boolean {
    return this.container !== 0;
  }
}

export interface QueueItem {
  kind: 'unit' | 'research';
  key: UnitKey | ResearchKey;
  t: number;
  total: number;
  cost: number;
}

export class Building {
  readonly kind = 'building' as const;
  hp: number;
  maxHp: number;
  dead = false;
  built = false;
  progress = 0;
  queue: QueueItem[] = [];
  rally: { x: number; y: number } | null = null;
  cds: number[];
  turret = -Math.PI / 2;
  target: Entity | null = null;
  scanT = 0;
  garrison: Unit | null = null;
  charge = 0;
  dropT = 0;
  dropFx = false;
  lastHurtT = -99;
  lastFireT = -99;
  fireAnim = 0;
  hostileTo = [0, 0, 0, 0, 0];
  /** Marauder camp this belongs to (-1 = none). */
  camp = -1;
  stalled = false;

  constructor(
    readonly id: number,
    readonly owner: number,
    readonly faction: FactionId,
    readonly key: BuildingKey,
    readonly def: BuildingDef,
    readonly tx: number,
    readonly ty: number,
  ) {
    this.maxHp = def.hp;
    this.hp = def.hp;
    this.cds = (def.weapons ?? []).map(() => Math.random());
    this.charge = def.superweapon?.charge ?? 0;
  }

  get w(): number {
    return this.def.w;
  }
  get h(): number {
    return this.def.h;
  }
  get x(): number {
    return this.tx + this.def.w / 2;
  }
  get y(): number {
    return this.ty + this.def.h / 2;
  }
  get radius(): number {
    return Math.max(this.def.w, this.def.h) / 2;
  }
  get armor() {
    return 'bldg' as const;
  }
  get air(): boolean {
    return false;
  }
}

export class Pile {
  readonly kind = 'pile' as const;
  readonly w = 2;
  readonly h = 2;
  loading = 0;
  dead = false;
  readonly max: number;
  constructor(
    readonly id: number,
    readonly tx: number,
    readonly ty: number,
    public amount: number,
    readonly label: string,
  ) {
    this.max = amount;
  }
  get x(): number {
    return this.tx + 1;
  }
  get y(): number {
    return this.ty + 1;
  }
  get radius(): number {
    return 1;
  }
}

export type Entity = Unit | Building;
export type Thing = Unit | Building | Pile;

export interface Projectile {
  fx: FxKind;
  x: number;
  y: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  target: number;
  speed: number;
  damage: number;
  dmg: DmgType;
  splash: number;
  owner: number;
  src: number;
  t: number;
  dur: number;
  toAir: boolean;
  faction: FactionId;
}

/** Visual/audio events the simulation reports to the renderer. */
export type FxEvent =
  | { k: 'shot'; fx: FxKind; x: number; y: number; x2: number; y2: number; owner: number; faction: FactionId; air: boolean }
  | { k: 'impact'; fx: FxKind; x: number; y: number; size: number; air: boolean }
  | { k: 'explode'; x: number; y: number; size: number; air: boolean }
  | { k: 'death'; x: number; y: number; faction: FactionId; owner: number }
  | { k: 'text'; x: number; y: number; text: string; color: string; owner: number }
  | { k: 'drop'; x: number; y: number; faction: FactionId; owner: number }
  | { k: 'super'; x: number; y: number; faction: FactionId; radius: number; phase: 'warn' | 'hit' }
  | { k: 'recon'; x: number; y: number; r: number; owner: number }
  | { k: 'build'; x: number; y: number }
  | { k: 'grenade'; x: number; y: number; x2: number; y2: number };

export interface Alert {
  owner: number;
  text: string;
  x: number;
  y: number;
  kind: 'attack' | 'info' | 'done' | 'warn';
  t: number;
  /** Increasing number, so the HUD can tell which alerts are new. */
  seq: number;
}
