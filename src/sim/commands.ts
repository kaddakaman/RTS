// Every order a player can give, as plain data. Local games apply them
// straight to the world; online games send them to the host, which applies
// them on behalf of that player.

import type { BuildingKey, ResearchKey, UnitKey } from '../data/defs';
import type { Building, Unit } from './entities';
import type { World } from './world';

export type Command =
  | { c: 'smart'; units: number[]; x: number; y: number; hover: number }
  | { c: 'move'; units: number[]; x: number; y: number; am: boolean }
  | { c: 'attack'; units: number[]; target: number }
  | { c: 'ability'; units: number[] }
  | { c: 'stop'; units: number[] }
  | { c: 'construct'; key: BuildingKey; tx: number; ty: number; builders: number[] }
  | { c: 'cancelConstruct'; b: number }
  | { c: 'queue'; b: number; key: UnitKey }
  | { c: 'research'; b: number; key: ResearchKey }
  | { c: 'cancel'; b: number }
  | { c: 'rally'; b: number; x: number; y: number }
  | { c: 'eject'; b: number }
  | { c: 'super'; x: number; y: number }
  | { c: 'surrender' };

function myUnits(w: World, owner: number, ids: number[]): Unit[] {
  const out: Unit[] = [];
  for (const id of ids) {
    const e = w.byId.get(id);
    if (e && e.kind === 'unit' && e.owner === owner && !e.dead) out.push(e);
  }
  return out;
}

function myBuilding(w: World, owner: number, id: number): Building | null {
  const e = w.byId.get(id);
  return e && e.kind === 'building' && e.owner === owner && !e.dead ? e : null;
}

const num = (v: unknown) => typeof v === 'number' && isFinite(v);

/**
 * Applies a command for `owner`. Returns '' or a short result word on
 * success (e.g. 'attack', 'gather'), or an error message for the player.
 */
export function applyCommand(w: World, owner: number, cmd: Command): string {
  const pl = w.players[owner];
  if (!pl || !pl.active || pl.defeated || w.over) return 'Not in the game';
  switch (cmd.c) {
    case 'smart': {
      if (!num(cmd.x) || !num(cmd.y)) return 'Bad target';
      const hover = cmd.hover ? (w.byId.get(cmd.hover) ?? null) : null;
      return w.cmdSmart(owner, myUnits(w, owner, cmd.units), cmd.x, cmd.y, hover);
    }
    case 'move':
      if (!num(cmd.x) || !num(cmd.y)) return 'Bad target';
      w.cmdMove(myUnits(w, owner, cmd.units), cmd.x, cmd.y, !!cmd.am);
      return 'move';
    case 'attack': {
      const t = w.entity(cmd.target);
      if (!t || t.dead || !w.hostile(owner, t.owner)) return 'Invalid target';
      w.cmdAttack(myUnits(w, owner, cmd.units), t);
      return 'attack';
    }
    case 'ability':
      return w.cmdAbility(owner, myUnits(w, owner, cmd.units)) || 'Nothing to use';
    case 'stop':
      w.cmdStop(myUnits(w, owner, cmd.units));
      return '';
    case 'construct': {
      const builders = myUnits(w, owner, cmd.builders).filter((u) => u.def.role === 'builder');
      if (!builders.length) return 'Select a builder first';
      const r = w.startConstruction(owner, cmd.key, Math.round(cmd.tx), Math.round(cmd.ty), builders);
      return typeof r === 'string' ? r : '';
    }
    case 'cancelConstruct': {
      const b = myBuilding(w, owner, cmd.b);
      if (!b || b.built) return 'Nothing to cancel';
      w.cancelConstruction(b);
      return '';
    }
    case 'queue': {
      const b = myBuilding(w, owner, cmd.b);
      if (!b) return 'Building lost';
      return w.queueUnit(b, cmd.key);
    }
    case 'research': {
      const b = myBuilding(w, owner, cmd.b);
      if (!b) return 'Building lost';
      return w.queueResearch(b, cmd.key);
    }
    case 'cancel': {
      const b = myBuilding(w, owner, cmd.b);
      if (!b) return 'Building lost';
      return w.cancelLast(b) ? '' : 'Queue is empty';
    }
    case 'rally': {
      const b = myBuilding(w, owner, cmd.b);
      if (!b || !num(cmd.x) || !num(cmd.y)) return 'Building lost';
      w.setRally(b, cmd.x, cmd.y);
      return '';
    }
    case 'eject': {
      const b = myBuilding(w, owner, cmd.b);
      if (!b || !b.garrison) return 'Nobody inside';
      w.unload(b);
      return '';
    }
    case 'super':
      if (!num(cmd.x) || !num(cmd.y)) return 'Bad target';
      return w.fireSuperweapon(owner, cmd.x, cmd.y);
    case 'surrender':
      w.defeat(owner);
      return '';
  }
  return 'Unknown command';
}
