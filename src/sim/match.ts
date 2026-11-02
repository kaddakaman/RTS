// Sets up a skirmish: the world, the Marauders and any computer players.

import type { FactionId } from '../data/defs';
import { SkirmishAI } from './ai';
import { NeutralAI } from './neutral';
import { World, type Difficulty, type MatchSetup, type SlotSetup } from './world';

export function createMatch(setup: MatchSetup): World {
  const w = new World(setup);
  w.controllers.push(new NeutralAI(w));
  setup.slots.forEach((s, i) => {
    if (s.kind === 'ai') w.controllers.push(new SkirmishAI(w, i, s.difficulty ?? 'normal'));
  });
  return w;
}

/** Quick 1v1 setup: slot 0 vs slot 2, the other bases go to the Marauders. */
export function duel(a: FactionId, b: FactionId, aiA: Difficulty | null, aiB: Difficulty | null, centerOutpost = true): MatchSetup {
  const slot = (kind: SlotSetup['kind'], faction: FactionId, team: number, name: string, difficulty?: Difficulty): SlotSetup => ({ kind, faction, team, name, difficulty });
  return {
    slots: [
      aiA ? slot('ai', a, 0, 'Blue AI', aiA) : slot('local', a, 0, 'You'),
      slot('marauder', 'marauder', -1, 'Marauders'),
      aiB ? slot('ai', b, 1, 'Red AI', aiB) : slot('local', b, 1, 'Player 2'),
      slot('marauder', 'marauder', -1, 'Marauders'),
    ],
    centerOutpost,
  };
}
