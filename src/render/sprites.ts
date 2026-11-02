// Procedural art for every unit and building. Everything is drawn in "tile"
// units (1 = one map tile) so it scales with the camera zoom.
//
// Shape language: the Coalition is boxy, olive and wheeled/tracked; the
// Sythari are rounded, violet and hover on teal glows; the Marauders are
// rusty scrap. Team colour (blue / red / green / yellow / orange) marks who
// owns what.

import { FACTIONS, type BuildingKey, type FactionId } from '../data/defs';
import type { Building, Unit } from '../sim/entities';
import { rgba, shade } from './color';

type C = CanvasRenderingContext2D;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- tiny helpers

function ell(ctx: C, x: number, y: number, rx: number, ry: number, rot = 0): void {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.001, rx), Math.max(0.001, ry), rot, 0, TAU);
  ctx.fill();
}

function rr(ctx: C, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fillRR(ctx: C, x: number, y: number, w: number, h: number, r: number, color: string): void {
  ctx.fillStyle = color;
  rr(ctx, x, y, w, h, r);
  ctx.fill();
}

function poly(ctx: C, pts: number[], color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fill();
}

function line(ctx: C, x1: number, y1: number, x2: number, y2: number, w: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function circle(ctx: C, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.001, r), 0, TAU);
  ctx.fill();
}

function pal(f: FactionId) {
  return FACTIONS[f].palette;
}

/** Flying height used for drawing aircraft (they're drawn this far "up" the screen). */
export function altitude(u: Unit): number {
  if (!u.air) return 0;
  if (!u.moving && u.def.bomber) return 0.25;
  return u.def.bomber ? 1.3 : u.key === 'dropship' ? 1.0 : 0.9;
}

// ---------------------------------------------------------------- units

export function drawUnitShadow(ctx: C, u: Unit): void {
  const alt = altitude(u);
  ctx.fillStyle = alt > 0 ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.28)';
  const r = u.def.members ? 0.62 : u.radius;
  if (alt > 0) {
    ctx.save();
    ctx.translate(u.x + alt * 0.3, u.y + 0.15);
    ctx.rotate(u.angle);
    ell(ctx, 0, 0, r * 1.05, r * 0.55);
    ctx.restore();
  } else if (!u.def.members) {
    ctx.save();
    ctx.translate(u.x + 0.08, u.y + 0.1);
    ctx.rotate(u.angle);
    ell(ctx, 0, 0, r * 0.95, r * 0.7);
    ctx.restore();
  }
}

/** Team-coloured ring under every unit so sides are easy to tell apart. */
export function drawTeamRing(ctx: C, u: Unit, team: string): void {
  if (u.air) return;
  const r = u.def.members ? 0.62 : u.radius * 0.95;
  ctx.strokeStyle = rgba(team, 0.55);
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.ellipse(u.x, u.y + 0.05, r, r * 0.72, 0, 0, TAU);
  ctx.stroke();
}

export function drawUnit(ctx: C, u: Unit, team: string, time: number): void {
  const alt = altitude(u);
  ctx.save();
  ctx.translate(u.x, u.y - alt);
  if (u.def.members) drawSquad(ctx, u, team, time);
  else {
    ctx.rotate(u.angle);
    const f = u.faction;
    if (f === 'sythari') drawSythariVehicle(ctx, u, team, time);
    else if (f === 'marauder') drawMarauderVehicle(ctx, u, team, time);
    else drawCoalitionVehicle(ctx, u, team, time);
  }
  ctx.restore();
}

// ---- infantry squads

const FORMATIONS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [
    [0.14, -0.19],
    [-0.12, 0.2],
  ],
  3: [
    [0.25, 0],
    [-0.1, -0.24],
    [-0.1, 0.24],
  ],
  4: [
    [0.3, 0],
    [0, -0.3],
    [0, 0.3],
    [-0.3, 0],
  ],
  5: [
    [0.34, 0],
    [0.08, -0.33],
    [0.08, 0.33],
    [-0.26, -0.16],
    [-0.26, 0.18],
  ],
  6: [
    [0.34, 0],
    [0.08, -0.33],
    [0.08, 0.33],
    [-0.26, -0.16],
    [-0.26, 0.18],
    [-0.5, 0],
  ],
};

function drawSquad(ctx: C, u: Unit, team: string, time: number): void {
  const n = u.members;
  const alive = u.alive;
  const form = FORMATIONS[Math.min(6, n)] ?? FORMATIONS[6];
  const p = pal(u.faction);
  const firing = u.fireAnim > 0;
  const ca = Math.cos(u.angle);
  const sa = Math.sin(u.angle);
  for (let i = 0; i < Math.min(alive, form.length); i++) {
    // the medic is the last member and stays alive longest
    const isMedic = u.medic && i === alive - 1;
    let [fx, fy] = form[u.medic && isMedic ? Math.min(form.length - 1, n - 1) : i];
    const bob = u.moving ? Math.sin(time * 12 + i * 1.7) * 0.025 : 0;
    fx += bob;
    const x = fx * ca - fy * sa;
    const y = fx * sa + fy * ca;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(u.angle);
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ell(ctx, 0.03, 0.06, 0.15, 0.11);
    drawSoldier(ctx, u, i, isMedic, team, p, firing && !isMedic && (u.key !== 'sniper' && u.key !== 'rocket' ? true : i === 0), time);
    ctx.restore();
  }
}

function drawSoldier(ctx: C, u: Unit, i: number, medic: boolean, team: string, p: ReturnType<typeof pal>, firing: boolean, time: number): void {
  const f = u.faction;
  const role = u.key;
  if (f === 'sythari') {
    // slender alien warrior
    ctx.fillStyle = shade(team, -0.15);
    ell(ctx, -0.02, 0, 0.1, 0.14);
    ctx.fillStyle = p.body;
    ell(ctx, 0.0, 0, 0.07, 0.11);
    // weapon
    if (!medic) {
      if (role === 'sniper' && i === 0) {
        line(ctx, 0.02, 0.07, 0.38, 0.07, 0.04, p.dark);
        circle(ctx, 0.38, 0.07, 0.025, p.glow);
      } else if (role === 'rocket' && i === 0) {
        fillRR(ctx, -0.05, 0.03, 0.34, 0.1, 0.04, p.dark);
        circle(ctx, 0.27, 0.08, 0.05, p.glow);
      } else if (role === 'sniper' || role === 'rocket') {
        // seer / charger with a glowing pack
        circle(ctx, -0.1, 0, 0.06, rgba(p.glow, 0.8));
      } else {
        line(ctx, 0.02, 0.07, 0.26, 0.07, 0.035, p.dark);
        circle(ctx, 0.26, 0.07, 0.02, p.glow);
      }
    } else {
      circle(ctx, -0.08, 0, 0.05, '#7dffb0');
    }
    // elongated head with visor
    ctx.fillStyle = p.light;
    ell(ctx, 0.04, 0, 0.07, 0.05);
    circle(ctx, 0.08, 0, 0.022, p.glow);
    if (firing) circle(ctx, role === 'sniper' ? 0.42 : 0.3, 0.07, 0.06, rgba(p.glow, 0.85));
    return;
  }
  // humans (Coalition) and Marauders
  const marauder = f === 'marauder';
  ctx.fillStyle = medic ? '#e8e8e2' : team;
  ell(ctx, -0.02, 0, 0.1, 0.13);
  if (!medic) {
    if (role === 'sniper' && i === 0) line(ctx, 0, 0.06, 0.38, 0.06, 0.035, '#1d1d1a');
    else if ((role === 'rocket' || role === 'rocketeer') && i === 0) {
      line(ctx, -0.12, 0.08, 0.26, 0.08, 0.075, marauder ? '#5b4a34' : '#3d4430');
      if (firing) circle(ctx, -0.16, 0.08, 0.06, 'rgba(230,230,220,0.6)');
    } else if (role === 'sniper') {
      // spotter with binoculars
      circle(ctx, 0.1, -0.03, 0.025, '#222');
      circle(ctx, 0.1, 0.03, 0.025, '#222');
    } else if (role === 'rocket' || role === 'rocketeer') {
      // loader carrying a spare rocket
      fillRR(ctx, -0.14, -0.06, 0.1, 0.12, 0.02, '#4a4a3a');
    } else line(ctx, 0, 0.06, 0.24, 0.06, 0.035, '#1d1d1a');
  }
  // helmet / hood
  ctx.fillStyle = medic ? '#f2f2ee' : marauder ? '#6e5236' : p.body;
  ell(ctx, 0.02, 0, 0.08, 0.075);
  if (medic) {
    line(ctx, -0.02, 0, 0.06, 0, 0.025, '#d33');
    line(ctx, 0.02, -0.04, 0.02, 0.04, 0.025, '#d33');
  }
  if (firing && !medic) {
    const fx = role === 'sniper' ? 0.42 : role === 'rocket' || role === 'rocketeer' ? 0.3 : 0.28;
    circle(ctx, fx, 0.06, 0.055 + Math.sin(time * 50) * 0.01, 'rgba(255,220,120,0.9)');
  }
}

// ---- Coalition vehicles

function wheels(ctx: C, xs: number[], hw: number, r: number): void {
  ctx.fillStyle = '#1e1e1c';
  for (const x of xs) {
    rr(ctx, x - r, -hw - 0.05, r * 2, 0.11, 0.03);
    ctx.fill();
    rr(ctx, x - r, hw - 0.06, r * 2, 0.11, 0.03);
    ctx.fill();
  }
}

function tracks(ctx: C, len: number, hw: number, time: number, moving: boolean): void {
  ctx.fillStyle = '#23231f';
  rr(ctx, -len / 2, -hw - 0.04, len, 0.2, 0.06);
  ctx.fill();
  rr(ctx, -len / 2, hw - 0.16, len, 0.2, 0.06);
  ctx.fill();
  ctx.strokeStyle = '#3d3d36';
  ctx.lineWidth = 0.025;
  const off = moving ? (time * 2) % 0.12 : 0;
  ctx.beginPath();
  for (let x = -len / 2 + off; x < len / 2; x += 0.12) {
    ctx.moveTo(x, -hw - 0.04);
    ctx.lineTo(x, -hw + 0.16);
    ctx.moveTo(x, hw - 0.16);
    ctx.lineTo(x, hw + 0.04);
  }
  ctx.stroke();
}

function muzzle(ctx: C, x: number, y: number, u: Unit, color = 'rgba(255,220,120,0.95)'): void {
  if (u.fireAnim <= 0) return;
  circle(ctx, x, y, 0.09 + u.fireAnim * 0.5, color);
}

function drawCoalitionVehicle(ctx: C, u: Unit, team: string, time: number): void {
  const p = pal('coalition');
  const tr = u.turret - u.angle;
  switch (u.key) {
    case 'builder': {
      tracks(ctx, 0.8, 0.34, time, u.moving);
      fillRR(ctx, -0.36, -0.26, 0.66, 0.52, 0.06, '#d1a52c');
      fillRR(ctx, -0.36, -0.26, 0.66, 0.1, 0.04, team);
      fillRR(ctx, -0.25, -0.17, 0.26, 0.34, 0.04, '#3a3a33');
      circle(ctx, -0.12, 0, 0.06, rgba('#9fd6ff', 0.7));
      // blade
      fillRR(ctx, 0.38, -0.42, 0.12, 0.84, 0.03, '#5c5c55');
      line(ctx, 0.3, -0.2, 0.38, -0.3, 0.05, '#4a4a44');
      line(ctx, 0.3, 0.2, 0.38, 0.3, 0.05, '#4a4a44');
      break;
    }
    case 'truck': {
      wheels(ctx, [-0.32, 0.0, 0.3], 0.27, 0.09);
      fillRR(ctx, -0.48, -0.27, 0.62, 0.54, 0.04, p.dark);
      fillRR(ctx, 0.16, -0.25, 0.32, 0.5, 0.07, p.body);
      fillRR(ctx, 0.3, -0.2, 0.12, 0.4, 0.03, rgba('#9fd6ff', 0.7));
      fillRR(ctx, 0.16, -0.25, 0.08, 0.5, 0.02, team);
      if (u.cargo > 0) {
        fillRR(ctx, -0.44, -0.22, 0.24, 0.2, 0.02, '#a07a3c');
        fillRR(ctx, -0.18, -0.2, 0.24, 0.2, 0.02, '#8c6a34');
        fillRR(ctx, -0.42, 0.02, 0.26, 0.2, 0.02, '#946f37');
      }
      break;
    }
    case 'scout': {
      wheels(ctx, [-0.25, 0.25], 0.28, 0.12);
      fillRR(ctx, -0.36, -0.2, 0.72, 0.4, 0.1, team);
      ctx.strokeStyle = '#2a2a26';
      ctx.lineWidth = 0.04;
      rr(ctx, -0.22, -0.17, 0.34, 0.34, 0.05);
      ctx.stroke();
      line(ctx, -0.22, 0, 0.12, 0, 0.03, '#2a2a26');
      circle(ctx, 0.0, 0, 0.07, '#e8e0c8');
      // antenna
      line(ctx, -0.3, -0.12, -0.5, -0.24, 0.02, '#222');
      break;
    }
    case 'light': {
      wheels(ctx, [-0.28, 0.26], 0.3, 0.11);
      fillRR(ctx, -0.45, -0.28, 0.9, 0.56, 0.09, p.body);
      fillRR(ctx, 0.15, -0.26, 0.3, 0.52, 0.08, shade(p.body, -0.12));
      fillRR(ctx, 0.25, -0.22, 0.06, 0.44, 0.02, team);
      fillRR(ctx, -0.12, -0.2, 0.22, 0.4, 0.04, rgba('#9fd6ff', 0.55));
      // MG turret
      ctx.save();
      ctx.translate(-0.15, 0);
      ctx.rotate(tr);
      circle(ctx, 0, 0, 0.13, shade(p.body, -0.25));
      line(ctx, 0.05, 0, 0.42, 0, 0.05, '#1c1c1a');
      circle(ctx, 0, 0, 0.07, team);
      muzzle(ctx, 0.46, 0, u);
      ctx.restore();
      break;
    }
    case 'tank': {
      tracks(ctx, 1.25, 0.46, time, u.moving);
      fillRR(ctx, -0.56, -0.34, 1.12, 0.68, 0.08, p.body);
      fillRR(ctx, 0.36, -0.3, 0.16, 0.6, 0.04, shade(p.body, -0.15));
      fillRR(ctx, -0.56, -0.08, 0.12, 0.16, 0.03, '#2b2b26');
      ctx.save();
      ctx.translate(-0.05, 0);
      ctx.rotate(tr);
      line(ctx, 0.2, 0, 0.85, 0, 0.1, '#2c2f26');
      fillRR(ctx, 0.78, -0.07, 0.12, 0.14, 0.03, '#2c2f26');
      fillRR(ctx, -0.3, -0.27, 0.56, 0.54, 0.14, team);
      fillRR(ctx, -0.22, -0.2, 0.4, 0.4, 0.1, shade(team, 0.15));
      circle(ctx, -0.1, -0.08, 0.07, shade(team, -0.3));
      muzzle(ctx, 0.95, 0, u);
      ctx.restore();
      break;
    }
    case 'apc': {
      wheels(ctx, [-0.38, 0, 0.36], 0.33, 0.1);
      fillRR(ctx, -0.6, -0.34, 1.2, 0.68, 0.08, p.body);
      fillRR(ctx, 0.3, -0.3, 0.26, 0.6, 0.06, shade(p.body, -0.12));
      fillRR(ctx, 0.42, -0.24, 0.08, 0.48, 0.02, rgba('#9fd6ff', 0.6));
      fillRR(ctx, -0.55, -0.34, 0.8, 0.1, 0.03, team);
      fillRR(ctx, -0.45, -0.18, 0.62, 0.36, 0.04, shade(p.body, 0.1));
      for (let i = 0; i < u.passengers.length; i++) circle(ctx, -0.32 + i * 0.3, 0, 0.09, team);
      break;
    }
    case 'bomber': {
      // delta-wing jet
      poly(ctx, [0.75, 0, -0.45, -0.68, -0.32, 0, -0.45, 0.68], shade(p.body, -0.05));
      poly(ctx, [0.75, 0, -0.45, -0.68, -0.3, -0.5], shade(p.body, 0.12));
      fillRR(ctx, -0.6, -0.12, 1.3, 0.24, 0.1, p.body);
      poly(ctx, [-0.45, -0.68, -0.36, -0.5, -0.3, -0.55, -0.42, -0.72], team);
      poly(ctx, [-0.45, 0.68, -0.36, 0.5, -0.3, 0.55, -0.42, 0.72], team);
      ell(ctx, 0.35, 0, 0.14, 0.06);
      ctx.fillStyle = rgba('#9fd6ff', 0.8);
      ell(ctx, 0.35, 0, 0.12, 0.05);
      if (u.moving) circle(ctx, -0.66, 0, 0.08 + Math.sin(time * 40) * 0.02, 'rgba(255,170,60,0.9)');
      if (u.ammo > 0) {
        circle(ctx, -0.05, -0.32, 0.06, '#2b2b26');
        circle(ctx, -0.05, 0.32, 0.06, '#2b2b26');
      }
      break;
    }
    case 'gunship': {
      line(ctx, -0.2, 0, -0.85, 0, 0.1, p.dark);
      fillRR(ctx, -0.9, -0.16, 0.12, 0.32, 0.03, p.dark);
      fillRR(ctx, -0.35, -0.42, 0.25, 0.84, 0.04, shade(p.body, -0.2));
      fillRR(ctx, -0.33, -0.48, 0.2, 0.1, 0.03, '#2c2c27');
      fillRR(ctx, -0.33, 0.38, 0.2, 0.1, 0.03, '#2c2c27');
      ctx.fillStyle = p.body;
      ell(ctx, 0.05, 0, 0.45, 0.2);
      ctx.fillStyle = team;
      ell(ctx, -0.05, 0, 0.22, 0.12);
      ctx.fillStyle = rgba('#9fd6ff', 0.75);
      ell(ctx, 0.32, 0, 0.13, 0.11);
      muzzle(ctx, 0.55, 0, u);
      rotor(ctx, 0, 0, 0.82, time, 1);
      break;
    }
    case 'dropship': {
      fillRR(ctx, -0.8, -0.24, 1.6, 0.48, 0.18, p.body);
      fillRR(ctx, -0.7, -0.24, 1.4, 0.1, 0.05, team);
      fillRR(ctx, 0.5, -0.17, 0.18, 0.34, 0.06, rgba('#9fd6ff', 0.75));
      for (let i = 0; i < u.passengers.length; i++) circle(ctx, -0.25 + i * 0.32, 0.05, 0.09, team);
      rotor(ctx, 0.55, 0, 0.62, time, 1);
      rotor(ctx, -0.55, 0, 0.62, time, -1);
      break;
    }
  }
}

function rotor(ctx: C, x: number, y: number, r: number, time: number, dir: number): void {
  ctx.fillStyle = 'rgba(40,40,36,0.18)';
  ell(ctx, x, y, r, r);
  const a = time * 30 * dir;
  ctx.strokeStyle = 'rgba(30,30,28,0.55)';
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  for (let k = 0; k < 2; k++) {
    const aa = a + (k * Math.PI) / 2;
    ctx.moveTo(x - Math.cos(aa) * r, y - Math.sin(aa) * r);
    ctx.lineTo(x + Math.cos(aa) * r, y + Math.sin(aa) * r);
  }
  ctx.stroke();
  circle(ctx, x, y, 0.06, '#2a2a26');
}

// ---- Sythari vehicles

function hoverGlow(ctx: C, rx: number, ry: number, time: number, glow: string): void {
  ctx.fillStyle = rgba(glow, 0.22 + Math.sin(time * 6) * 0.05);
  ell(ctx, 0, 0, rx, ry);
}

function drawSythariVehicle(ctx: C, u: Unit, team: string, time: number): void {
  const p = pal('sythari');
  const tr = u.turret - u.angle;
  const g = p.glow;
  switch (u.key) {
    case 'builder': {
      hoverGlow(ctx, 0.45, 0.45, time, g);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU + time * 0.8;
        line(ctx, 0, 0, Math.cos(a) * 0.42, Math.sin(a) * 0.42, 0.06, p.dark);
        circle(ctx, Math.cos(a) * 0.42, Math.sin(a) * 0.42, 0.06, p.light);
      }
      circle(ctx, 0, 0, 0.27, p.body);
      circle(ctx, 0, 0, 0.18, team);
      circle(ctx, 0, 0, 0.09, g);
      break;
    }
    case 'truck': {
      hoverGlow(ctx, 0.5, 0.36, time, g);
      ctx.fillStyle = p.body;
      ell(ctx, 0, 0, 0.45, 0.3);
      ctx.fillStyle = team;
      ell(ctx, 0.22, 0, 0.16, 0.2);
      const fill = u.cargo > 0 ? 0.9 : 0.35;
      circle(ctx, -0.12, 0, 0.17, p.dark);
      circle(ctx, -0.12, 0, 0.14, rgba(g, fill));
      break;
    }
    case 'scout': {
      hoverGlow(ctx, 0.45, 0.25, time, g);
      poly(ctx, [0.45, 0, -0.35, -0.24, -0.2, 0, -0.35, 0.24], p.body);
      poly(ctx, [0.45, 0, -0.2, -0.1, -0.2, 0.1], team);
      circle(ctx, 0.08, 0, 0.06, g);
      if (u.moving) line(ctx, -0.3, 0, -0.65, 0, 0.08, rgba(g, 0.4));
      break;
    }
    case 'light': {
      hoverGlow(ctx, 0.55, 0.38, time, g);
      ctx.fillStyle = p.body;
      ctx.beginPath();
      ctx.arc(0.05, 0, 0.42, -2.3, 2.3);
      ctx.quadraticCurveTo(-0.15, 0, Math.cos(-2.3) * 0.42 + 0.05, Math.sin(-2.3) * 0.42);
      ctx.fill();
      ctx.fillStyle = team;
      ell(ctx, 0.1, 0, 0.2, 0.14);
      ctx.save();
      ctx.translate(0.05, 0);
      ctx.rotate(tr);
      line(ctx, 0, 0, 0.42, 0, 0.06, p.dark);
      circle(ctx, 0, 0, 0.1, p.light);
      circle(ctx, 0.42, 0, 0.035, g);
      muzzle(ctx, 0.46, 0, u, rgba(g, 0.9));
      ctx.restore();
      break;
    }
    case 'tank': {
      hoverGlow(ctx, 0.75, 0.55, time, g);
      poly(ctx, [0.62, 0, 0.32, -0.45, -0.38, -0.45, -0.62, 0, -0.38, 0.45, 0.32, 0.45], p.body);
      poly(ctx, [0.5, 0, 0.26, -0.33, -0.3, -0.33, -0.5, 0, -0.3, 0.33, 0.26, 0.33], shade(p.body, 0.1));
      fillRR(ctx, -0.6, -0.06, 0.15, 0.12, 0.04, rgba(g, 0.9));
      ctx.save();
      ctx.rotate(tr);
      line(ctx, 0.15, 0, 0.88, 0, 0.08, p.dark);
      line(ctx, 0.2, 0, 0.82, 0, 0.03, g);
      poly(ctx, [0.36, 0, 0, -0.26, -0.3, 0, 0, 0.26], team);
      circle(ctx, 0, 0, 0.1, g);
      muzzle(ctx, 0.92, 0, u, rgba(g, 0.95));
      ctx.restore();
      break;
    }
    case 'apc': {
      hoverGlow(ctx, 0.7, 0.45, time, g);
      fillRR(ctx, -0.6, -0.33, 1.2, 0.66, 0.3, p.body);
      ctx.strokeStyle = p.dark;
      ctx.lineWidth = 0.04;
      for (let x = -0.35; x <= 0.35; x += 0.23) {
        ctx.beginPath();
        ctx.moveTo(x, -0.31);
        ctx.quadraticCurveTo(x + 0.08, 0, x, 0.31);
        ctx.stroke();
      }
      ctx.fillStyle = team;
      ell(ctx, 0.42, 0, 0.12, 0.22);
      for (let i = 0; i < u.passengers.length; i++) circle(ctx, -0.25 + i * 0.3, 0, 0.08, g);
      break;
    }
    case 'bomber': {
      poly(ctx, [0.7, 0, 0.1, -0.15, -0.1, -0.7, -0.35, -0.6, -0.4, 0, -0.35, 0.6, -0.1, 0.7, 0.1, 0.15], p.body);
      poly(ctx, [-0.1, -0.7, -0.35, -0.6, -0.25, -0.45], team);
      poly(ctx, [-0.1, 0.7, -0.35, 0.6, -0.25, 0.45], team);
      ctx.fillStyle = p.light;
      ell(ctx, 0.2, 0, 0.3, 0.08);
      circle(ctx, 0.3, 0, 0.05, g);
      if (u.moving) circle(ctx, -0.45, 0, 0.09 + Math.sin(time * 40) * 0.02, rgba(g, 0.85));
      if (u.ammo > 0) circle(ctx, -0.05, 0, 0.08, rgba(g, 0.8));
      break;
    }
    case 'gunship': {
      ctx.fillStyle = rgba(g, 0.18);
      ell(ctx, 0, 0, 0.75, 0.75);
      ctx.fillStyle = p.body;
      ell(ctx, 0, 0, 0.5, 0.4);
      ctx.fillStyle = p.dark;
      ell(ctx, 0.0, -0.48, 0.25, 0.12);
      ell(ctx, 0.0, 0.48, 0.25, 0.12);
      circle(ctx, 0.22, -0.48, 0.05, g);
      circle(ctx, 0.22, 0.48, 0.05, g);
      ctx.fillStyle = team;
      ell(ctx, -0.05, 0, 0.24, 0.2);
      circle(ctx, 0.2, 0, 0.08, g);
      muzzle(ctx, 0.55, 0, u, rgba(g, 0.9));
      break;
    }
    case 'dropship': {
      ctx.fillStyle = rgba(g, 0.2);
      ell(ctx, 0, 0, 0.95, 0.75);
      poly(ctx, [0.75, 0, 0.2, -0.75, -0.6, -0.55, -0.45, 0, -0.6, 0.55, 0.2, 0.75], p.body);
      poly(ctx, [0.6, 0, 0.15, -0.5, -0.35, 0, 0.15, 0.5], shade(p.body, 0.12));
      fillRR(ctx, -0.5, -0.08, 0.5, 0.16, 0.06, team);
      for (let i = 0; i < u.passengers.length; i++) circle(ctx, -0.1 + i * 0.28, 0.25, 0.08, g);
      circle(ctx, 0.45, 0, 0.06, g);
      break;
    }
  }
}

// ---- Marauder vehicles

function drawMarauderVehicle(ctx: C, u: Unit, team: string, time: number): void {
  const p = pal('marauder');
  const tr = u.turret - u.angle;
  if (u.key === 'technical') {
    wheels(ctx, [-0.28, 0.26], 0.3, 0.11);
    fillRR(ctx, -0.48, -0.28, 0.96, 0.56, 0.06, p.body);
    fillRR(ctx, 0.12, -0.26, 0.34, 0.52, 0.07, shade(p.body, -0.15));
    fillRR(ctx, 0.25, -0.2, 0.08, 0.4, 0.02, rgba('#cfe6ff', 0.5));
    fillRR(ctx, -0.4, -0.16, 0.12, 0.32, 0.02, team);
    ctx.save();
    ctx.translate(-0.18, 0);
    ctx.rotate(tr);
    circle(ctx, 0, 0, 0.12, p.dark);
    line(ctx, 0, 0, 0.42, 0, 0.05, '#1a1a18');
    muzzle(ctx, 0.46, 0, u);
    ctx.restore();
  } else {
    tracks(ctx, 1.2, 0.46, time, u.moving);
    fillRR(ctx, -0.55, -0.34, 1.1, 0.68, 0.04, p.body);
    fillRR(ctx, -0.4, -0.3, 0.3, 0.25, 0.02, shade(p.body, 0.15));
    fillRR(ctx, 0.1, 0.05, 0.35, 0.25, 0.02, shade(p.body, -0.2));
    ctx.save();
    ctx.rotate(tr);
    line(ctx, 0.2, 0, 0.82, 0, 0.1, '#33291e');
    fillRR(ctx, -0.28, -0.26, 0.52, 0.52, 0.06, p.dark);
    fillRR(ctx, -0.2, -0.18, 0.3, 0.2, 0.03, team);
    muzzle(ctx, 0.9, 0, u);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- buildings

const SPRITE_PX = 32;
const PAD_X = 0.5;
const PAD_TOP = 2.2;
const spriteCache = new Map<string, HTMLCanvasElement>();

/** Static part of a building, cached per faction / type / team colour. */
export function buildingSprite(faction: FactionId, key: BuildingKey, team: string): HTMLCanvasElement {
  const k = `${faction}|${key}|${team}`;
  let c = spriteCache.get(k);
  if (c) return c;
  const def = FACTIONS[faction].buildings[key]!;
  c = document.createElement('canvas');
  c.width = Math.ceil((def.w + PAD_X * 2) * SPRITE_PX);
  c.height = Math.ceil((def.h + PAD_TOP + 0.3) * SPRITE_PX);
  const ctx = c.getContext('2d')!;
  ctx.scale(SPRITE_PX, SPRITE_PX);
  ctx.translate(PAD_X, PAD_TOP);
  if (faction === 'sythari') drawSythariBuilding(ctx, key, def.w, def.h, team);
  else if (faction === 'marauder') drawMarauderBuilding(ctx, key, def.w, def.h, team);
  else drawCoalitionBuilding(ctx, key, def.w, def.h, team);
  spriteCache.set(k, c);
  return c;
}

/** Draws a building at its footprint (static sprite + animated parts). */
export function drawBuilding(ctx: C, b: { key: BuildingKey; faction: FactionId; tx: number; ty: number; w: number; h: number }, team: string, time: number, live?: Building): void {
  const spr = buildingSprite(b.faction, b.key, team);
  const built = live ? live.built : true;
  ctx.save();
  if (!built) ctx.globalAlpha = 0.45 + 0.4 * (live?.progress ?? 0);
  ctx.drawImage(spr, b.tx - PAD_X, b.ty - PAD_TOP, spr.width / SPRITE_PX, spr.height / SPRITE_PX);
  ctx.restore();
  if (!live) return;
  if (!built) {
    drawScaffold(ctx, b.tx, b.ty, b.w, b.h, live.progress);
    return;
  }
  drawBuildingLive(ctx, live, team, time);
}

function drawScaffold(ctx: C, x: number, y: number, w: number, h: number, prog: number): void {
  ctx.strokeStyle = 'rgba(70,60,40,0.85)';
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  for (let i = 0; i <= w; i++) {
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i, y + h);
  }
  for (let j = 0; j <= h; j++) {
    ctx.moveTo(x, y + j);
    ctx.lineTo(x + w, y + j);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(230,190,60,0.9)';
  ctx.setLineDash([0.2, 0.15]);
  ctx.strokeRect(x + 0.05, y + 0.05, w - 0.1, h - 0.1);
  ctx.setLineDash([]);
  // progress bar
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x + 0.2, y + h - 0.35, w - 0.4, 0.18);
  ctx.fillStyle = '#ffd34a';
  ctx.fillRect(x + 0.22, y + h - 0.33, (w - 0.44) * prog, 0.14);
}

function drawBuildingLive(ctx: C, b: Building, team: string, time: number): void {
  const x = b.tx;
  const y = b.ty;
  const w = b.w;
  const h = b.h;
  const tr = b.turret;
  const p = pal(b.faction);
  const sy = b.faction === 'sythari';
  switch (b.key) {
    case 'hq': {
      ctx.save();
      ctx.translate(x + w - 0.9, y + 0.5 - 0.9);
      ctx.rotate(tr);
      if (sy) {
        circle(ctx, 0, 0, 0.18, p.light);
        line(ctx, 0, 0, 0.5, 0, 0.06, p.dark);
        circle(ctx, 0.5, 0, 0.04, p.glow);
      } else {
        circle(ctx, 0, 0, 0.2, shade(p.body, -0.2));
        line(ctx, 0.05, 0, 0.55, 0, 0.07, '#1f1f1b');
      }
      if (b.fireAnim > 0) circle(ctx, 0.6, 0, 0.1, sy ? rgba(p.glow, 0.9) : 'rgba(255,220,120,0.9)');
      ctx.restore();
      if (!sy) {
        // spinning radar
        const a = time * 1.5;
        ctx.save();
        ctx.translate(x + 0.9, y + 0.3 - 0.9);
        ctx.rotate(a);
        fillRR(ctx, -0.3, -0.06, 0.6, 0.12, 0.05, '#d8d4c4');
        ctx.restore();
      } else {
        circle(ctx, x + w / 2, y + h / 2 - 1.75, 0.16 + Math.sin(time * 3) * 0.03, p.glow);
      }
      flag(ctx, x + 0.35, y + h - 0.4, team, time);
      break;
    }
    case 'sam':
    case 'tower':
    case 'arty': {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2 - (b.key === 'tower' ? 1.0 : 0.25));
      ctx.rotate(tr);
      if (b.key === 'sam') {
        if (sy) {
          circle(ctx, 0, 0, 0.22, p.dark);
          circle(ctx, 0.1, 0, 0.12, p.glow);
        } else {
          fillRR(ctx, -0.32, -0.3, 0.6, 0.6, 0.06, shade(p.body, -0.15));
          for (let k = 0; k < 4; k++) fillRR(ctx, -0.25 + (k % 2) * 0.27, -0.25 + Math.floor(k / 2) * 0.27, 0.22, 0.22, 0.04, '#e0dccb');
          fillRR(ctx, -0.32, -0.3, 0.08, 0.6, 0.02, team);
        }
      } else if (b.key === 'arty') {
        line(ctx, 0, 0, 1.15, 0, sy ? 0.12 : 0.14, sy ? p.dark : '#2c2f26');
        if (sy) circle(ctx, 1.15, 0, 0.08, p.glow);
        circle(ctx, 0, 0, 0.32, sy ? p.body : p.body);
        circle(ctx, 0, 0, 0.16, team);
        if (b.fireAnim > 0) circle(ctx, 1.25, 0, 0.18, sy ? rgba(p.glow, 0.9) : 'rgba(255,200,100,0.95)');
      } else {
        circle(ctx, 0, 0, 0.18, '#3a2e22');
        line(ctx, 0, 0, 0.5, 0, 0.06, '#1a1a18');
        if (b.fireAnim > 0) circle(ctx, 0.56, 0, 0.1, 'rgba(255,220,120,0.9)');
      }
      ctx.restore();
      break;
    }
    case 'fortress': {
      for (let k = 0; k < 2; k++) {
        ctx.save();
        ctx.translate(x + 0.7 + k * (w - 1.4), y + 0.6 - 0.6);
        ctx.rotate(tr + k * 0.3);
        circle(ctx, 0, 0, 0.2, '#3a2e22');
        line(ctx, 0, 0, 0.55, 0, 0.07, '#1a1a18');
        if (b.fireAnim > 0) circle(ctx, 0.6, 0, 0.1, 'rgba(255,220,120,0.9)');
        ctx.restore();
      }
      flag(ctx, x + w / 2, y + h / 2 - 1.2, team, time);
      break;
    }
    case 'bunker': {
      if (b.garrison) {
        const n = Math.min(4, b.garrison.alive);
        for (let i = 0; i < n; i++) circle(ctx, x + 0.55 + i * 0.3, y + 0.6, 0.11, team);
        if (b.fireAnim > 0) circle(ctx, x + w / 2 + Math.cos(tr) * 0.9, y + h / 2 + Math.sin(tr) * 0.9 - 0.2, 0.12, sy ? rgba(p.glow, 0.9) : 'rgba(255,220,120,0.9)');
      }
      break;
    }
    case 'super': {
      const charge = b.def.superweapon ? 1 - b.charge / b.def.superweapon.charge : 0;
      const pulse = 0.5 + Math.sin(time * (charge >= 1 ? 8 : 2)) * 0.5;
      const cx = x + w / 2;
      const cy = y + h / 2 - (sy ? 2.0 : 0.9);
      ctx.fillStyle = charge >= 1 ? `rgba(255,80,60,${0.4 + pulse * 0.5})` : rgba(sy ? p.glow : '#ffd36a', 0.2 + charge * 0.6);
      ell(ctx, cx, cy, 0.25 + charge * 0.25, 0.25 + charge * 0.25);
      break;
    }
    case 'dropzone': {
      const on = Math.floor(time * 2) % 2 === 0;
      const lamp = on ? (sy ? p.glow : '#ffd34a') : 'rgba(80,70,40,0.6)';
      for (const [dx, dy] of [
        [0.3, 0.3],
        [w - 0.3, 0.3],
        [0.3, h - 0.3],
        [w - 0.3, h - 0.3],
      ])
        circle(ctx, x + dx, y + dy, 0.09, lamp);
      if (b.def.dropZone) {
        const k = b.dropT / b.def.dropZone.interval;
        ctx.strokeStyle = rgba(sy ? p.glow : '#ffd34a', 0.8);
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, 0.75, -Math.PI / 2, -Math.PI / 2 + TAU * k);
        ctx.stroke();
      }
      break;
    }
    default:
      if (b.key === 'barracks' || b.key === 'factory' || b.key === 'airbase' || b.key === 'depot') {
        if (b.queue.length) {
          // working lights
          const on = Math.sin(time * 6) > 0;
          circle(ctx, x + w - 0.3, y + h - 0.25, 0.07, on ? (sy ? p.glow : '#7dff7d') : 'rgba(40,60,40,0.6)');
        }
      }
  }
}

function flag(ctx: C, x: number, y: number, team: string, time: number): void {
  line(ctx, x, y, x, y - 1.1, 0.04, '#3b3b35');
  const wv = Math.sin(time * 5) * 0.06;
  poly(ctx, [x, y - 1.1, x + 0.45, y - 1.0 + wv, x + 0.4, y - 0.85 + wv, x, y - 0.8], team);
}

// ---- static building art

/** A 3/4-view box: roof at (x, y - hgt), front face below it. */
function box(ctx: C, x: number, y: number, w: number, h: number, hgt: number, roof: string, wall: string, r = 0.06): void {
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  rr(ctx, x + 0.12, y + 0.12, w, h, r);
  ctx.fill();
  fillRR(ctx, x, y + h - hgt - 0.02, w, hgt + 0.02, r, wall);
  fillRR(ctx, x, y - hgt, w, h, r, roof);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 0.03;
  rr(ctx, x, y - hgt, w, h, r);
  ctx.stroke();
}

function slab(ctx: C, w: number, h: number, color: string): void {
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  rr(ctx, 0.1, 0.12, w, h, 0.12);
  ctx.fill();
  fillRR(ctx, 0, 0, w, h, 0.12, color);
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 0.04;
  rr(ctx, 0.04, 0.04, w - 0.08, h - 0.08, 0.1);
  ctx.stroke();
}

function sandbags(ctx: C, x: number, y: number, n: number, horizontal = true): void {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? '#a89366' : '#b8a273';
    ell(ctx, x + (horizontal ? i * 0.22 : 0), y + (horizontal ? 0 : i * 0.22), 0.13, 0.09);
  }
}

function drawCoalitionBuilding(ctx: C, key: BuildingKey, w: number, h: number, team: string): void {
  const p = pal('coalition');
  const concrete = '#a7a08b';
  const wall = shade(p.body, -0.3);
  switch (key) {
    case 'hq': {
      slab(ctx, w, h, concrete);
      box(ctx, 0.35, 0.9, w - 0.7, h - 1.25, 0.9, p.body, wall, 0.1);
      fillRR(ctx, 0.35, 0.9 - 0.9 + 0.35, w - 0.7, 0.18, 0.03, team);
      box(ctx, 1.1, 1.0, 1.8, 1.4, 1.5, shade(p.body, 0.1), wall, 0.08);
      fillRR(ctx, 1.25, 1.0 - 1.5 + 0.2, 1.5, 0.3, 0.04, rgba('#9fd6ff', 0.65));
      // helipad mark
      ctx.strokeStyle = '#e8e2c8';
      ctx.lineWidth = 0.06;
      ctx.beginPath();
      ctx.arc(2.0, 1.0 - 1.5 + 0.95, 0.38, 0, TAU);
      ctx.stroke();
      // door
      fillRR(ctx, w / 2 - 0.35, h - 0.35 - 0.62, 0.7, 0.62, 0.05, '#2c2c27');
      sandbags(ctx, 0.25, h - 0.15, 4);
      sandbags(ctx, w - 1.0, h - 0.15, 4);
      // antenna mast
      line(ctx, 0.9, 0.3, 0.9, -1.2, 0.05, '#55554c');
      break;
    }
    case 'barracks': {
      slab(ctx, w, h, concrete);
      for (let k = 0; k < 2; k++) {
        const yy = 0.45 + k * 1.15;
        box(ctx, 0.2, yy, w - 0.4, 0.9, 0.45, p.body, wall, 0.4);
        fillRR(ctx, 0.3, yy - 0.45 + 0.12, w - 0.6, 0.14, 0.06, shade(p.body, 0.18));
        fillRR(ctx, 0.2, yy - 0.45 + 0.7, 0.4, 0.2, 0.05, team);
      }
      fillRR(ctx, w / 2 - 0.3, h - 0.62, 0.6, 0.45, 0.05, '#2c2c27');
      sandbags(ctx, 0.2, h - 0.08, 3);
      break;
    }
    case 'depot': {
      slab(ctx, w, h, concrete);
      box(ctx, 0.15, 0.6, 1.9, 1.9, 0.75, shade(p.body, 0.05), wall, 0.05);
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 0.03;
      for (let i = 0.3; i < 1.9; i += 0.22) line(ctx, 0.15 + i, 0.6 - 0.75, 0.15 + i, 0.6 - 0.75 + 1.9, 0.03, 'rgba(0,0,0,0.15)');
      fillRR(ctx, 0.15, 0.6 - 0.75 + 0.1, 1.9, 0.18, 0.03, team);
      fillRR(ctx, 0.6, 2.5 - 0.6, 0.9, 0.55, 0.04, '#2c2c27');
      // loading pad and crates
      ctx.fillStyle = '#d6b24a';
      ctx.fillRect(2.2, 0.3, 0.65, 2.4);
      ctx.fillStyle = '#2c2c27';
      for (let yy = 0.35; yy < 2.6; yy += 0.3) ctx.fillRect(2.2, yy, 0.65, 0.12);
      fillRR(ctx, 2.25, 0.6, 0.5, 0.45, 0.04, '#9a7438');
      fillRR(ctx, 2.3, 1.3, 0.45, 0.4, 0.04, '#86642f');
      break;
    }
    case 'defense': {
      slab(ctx, w, h, concrete);
      box(ctx, 0.2, 1.2, 1.5, 1.4, 0.6, p.body, wall);
      fillRR(ctx, 0.2, 1.2 - 0.6 + 0.12, 1.5, 0.16, 0.03, team);
      for (let i = 0; i < 3; i++) box(ctx, 1.95, 0.4 + i * 0.75, 0.8, 0.5, 0.35, '#b9b29c', '#8a846f', 0.04);
      // crane
      line(ctx, 0.5, 0.6, 0.5, -1.0, 0.07, '#c9a227');
      line(ctx, 0.5, -1.0, 2.2, -0.6, 0.06, '#c9a227');
      line(ctx, 2.0, -0.65, 2.0, 0.2, 0.025, '#333');
      break;
    }
    case 'factory': {
      slab(ctx, w, h, concrete);
      box(ctx, 0.25, 0.85, w - 0.5, h - 1.05, 1.0, shade(p.body, 0.05), wall, 0.08);
      fillRR(ctx, 0.25, 0.85 - 1.0 + 0.15, w - 0.5, 0.2, 0.03, team);
      for (let k = 0; k < 2; k++) {
        const dx = 0.55 + k * 1.55;
        fillRR(ctx, dx, h - 0.2 - 0.9, 1.3, 0.9, 0.04, '#3a3a33');
        for (let s = 0; s < 4; s++) fillRR(ctx, dx, h - 0.2 - 0.9 + s * 0.22, 1.3, 0.08, 0.01, '#d6b24a');
      }
      for (let k = 0; k < 3; k++) circle(ctx, 0.9 + k * 1.1, 0.85 - 1.0 + 1.0, 0.18, shade(p.body, -0.15));
      break;
    }
    case 'airbase': {
      slab(ctx, w, h, '#77746a');
      for (let k = 0; k < 2; k++) {
        const cx = 1 + k * 2;
        const cy = h - 1.2;
        circle(ctx, cx, cy, 0.62, '#5d5b54');
        ctx.strokeStyle = '#e8e2c8';
        ctx.lineWidth = 0.06;
        ctx.beginPath();
        ctx.arc(cx, cy, 0.55, 0, TAU);
        ctx.stroke();
        line(ctx, cx - 0.18, cy - 0.22, cx - 0.18, cy + 0.22, 0.07, '#e8e2c8');
        line(ctx, cx + 0.18, cy - 0.22, cx + 0.18, cy + 0.22, 0.07, '#e8e2c8');
        line(ctx, cx - 0.18, cy, cx + 0.18, cy, 0.07, '#e8e2c8');
      }
      box(ctx, 0.25, 0.55, 1.2, 1.0, 1.3, p.body, wall);
      fillRR(ctx, 0.3, 0.55 - 1.3 + 0.15, 1.1, 0.35, 0.04, rgba('#9fd6ff', 0.7));
      fillRR(ctx, 0.25, 0.55 - 1.3 + 0.7, 1.2, 0.12, 0.02, team);
      box(ctx, 1.8, 0.4, 1.9, 0.9, 0.6, shade(p.body, 0.08), wall);
      fillRR(ctx, 1.8, 0.4 - 0.6 + 0.4, 1.9, 0.12, 0.02, team);
      break;
    }
    case 'dropzone': {
      fillRR(ctx, 0, 0, w, h, 0.1, '#c4b07c');
      ctx.strokeStyle = '#d6b24a';
      ctx.lineWidth = 0.18;
      ctx.setLineDash([0.3, 0.3]);
      rr(ctx, 0.12, 0.12, w - 0.24, h - 0.24, 0.08);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#2c2c27';
      ctx.lineWidth = 0.1;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 0.75, 0, TAU);
      ctx.stroke();
      line(ctx, w / 2 - 0.5, h / 2, w / 2 + 0.5, h / 2, 0.08, team);
      line(ctx, w / 2, h / 2 - 0.5, w / 2, h / 2 + 0.5, 0.08, team);
      break;
    }
    case 'super': {
      slab(ctx, w, h, concrete);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ell(ctx, w / 2 + 0.15, h / 2 + 0.2, 1.6, 1.0);
      box(ctx, 0.6, 1.4, w - 1.2, 1.9, 0.6, shade(p.body, -0.05), wall, 0.3);
      fillRR(ctx, 0.6, 1.4 - 0.6 + 0.2, w - 1.2, 0.14, 0.04, team);
      // dish
      line(ctx, w / 2, 1.3, w / 2, 0.1, 0.12, '#55554c');
      ctx.fillStyle = '#dcd7c6';
      ell(ctx, w / 2, -0.1, 1.45, 0.75, -0.2);
      ctx.fillStyle = '#b9b3a0';
      ell(ctx, w / 2, -0.05, 1.15, 0.55, -0.2);
      line(ctx, w / 2, -0.1, w / 2, -0.9, 0.06, '#55554c');
      break;
    }
    case 'sam': {
      fillRR(ctx, 0.15, 0.15, w - 0.3, h - 0.3, 0.6, '#a59f8b');
      sandbags(ctx, 0.3, h - 0.25, 7);
      circle(ctx, w / 2, h / 2 - 0.25, 0.42, shade(p.body, -0.25));
      break;
    }
    case 'arty': {
      circle(ctx, w / 2 + 0.08, h / 2 + 0.1, 0.95, 'rgba(0,0,0,0.25)');
      circle(ctx, w / 2, h / 2, 0.92, '#a59f8b');
      circle(ctx, w / 2, h / 2, 0.7, '#6f6a5c');
      sandbags(ctx, 0.25, h - 0.15, 7);
      break;
    }
    case 'bunker': {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ell(ctx, w / 2 + 0.1, h / 2 + 0.15, 0.95, 0.85);
      poly(ctx, [0.35, 0.25, w - 0.35, 0.25, w - 0.1, 0.6, w - 0.1, h - 0.2, 0.1, h - 0.2, 0.1, 0.6], '#8f8a78');
      poly(ctx, [0.4, 0.0, w - 0.4, 0.0, w - 0.15, 0.3, w - 0.15, h - 0.6, 0.15, h - 0.6, 0.15, 0.3], '#b5af99');
      fillRR(ctx, 0.35, h - 0.55, w - 0.7, 0.14, 0.03, '#1f1f1b');
      fillRR(ctx, 0.15, 0.25, 0.1, h - 0.9, 0.02, team);
      break;
    }
  }
}

function crystal(ctx: C, x: number, y: number, w: number, hgt: number, color: string, glow: string): void {
  poly(ctx, [x, y - hgt, x + w / 2, y - hgt * 0.75, x + w / 2, y, x, y + w * 0.25, x - w / 2, y, x - w / 2, y - hgt * 0.75], color);
  poly(ctx, [x, y - hgt, x + w / 2, y - hgt * 0.75, x + w / 2, y, x, y + w * 0.25], shade(color, -0.2));
  line(ctx, x, y - hgt * 0.9, x, y, 0.04, rgba(glow, 0.7));
}

function drawSythariBuilding(ctx: C, key: BuildingKey, w: number, h: number, team: string): void {
  const p = pal('sythari');
  const base = '#6b5d82';
  const plate = (color = base) => {
    const cx = w / 2;
    const cy = h / 2;
    const rx = w / 2;
    const ry = h / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ell(ctx, cx + 0.12, cy + 0.15, rx, ry);
    poly(ctx, [cx - rx * 0.5, cy - ry, cx + rx * 0.5, cy - ry, cx + rx, cy, cx + rx * 0.5, cy + ry, cx - rx * 0.5, cy + ry, cx - rx, cy], color);
    ctx.strokeStyle = rgba(p.glow, 0.45);
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.moveTo(cx - rx * 0.5, cy - ry);
    ctx.lineTo(cx + rx * 0.5, cy - ry);
    ctx.lineTo(cx + rx, cy);
    ctx.lineTo(cx + rx * 0.5, cy + ry);
    ctx.lineTo(cx - rx * 0.5, cy + ry);
    ctx.lineTo(cx - rx, cy);
    ctx.closePath();
    ctx.stroke();
  };
  const dome = (cx: number, cy: number, rx: number, ry: number, hgt: number, color: string) => {
    ctx.fillStyle = shade(color, -0.3);
    ell(ctx, cx, cy, rx, ry);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(cx, cy - hgt * 0.4, rx, ry + hgt * 0.4, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ell(ctx, cx - rx * 0.3, cy - hgt * 0.4 - ry * 0.4, rx * 0.4, ry * 0.35);
  };
  switch (key) {
    case 'hq': {
      plate();
      for (const [dx, dy] of [
        [0.8, 1.2],
        [w - 0.8, 1.2],
        [0.9, h - 0.5],
        [w - 0.9, h - 0.5],
      ])
        crystal(ctx, dx, dy, 0.5, 1.0, p.body, p.glow);
      crystal(ctx, w / 2, h / 2 + 0.6, 1.3, 2.8, p.light, p.glow);
      circle(ctx, w / 2, h / 2 - 0.4, 0.22, team);
      break;
    }
    case 'barracks': {
      plate();
      dome(w / 2, h / 2 + 0.1, 1.15, 0.9, 1.0, p.body);
      ctx.strokeStyle = p.dark;
      ctx.lineWidth = 0.05;
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.ellipse(w / 2 + k * 0.45, h / 2 - 0.3, 0.12, 1.0, 0, 0, TAU);
        ctx.stroke();
      }
      fillRR(ctx, w / 2 - 0.3, h / 2 + 0.25, 0.6, 0.55, 0.25, rgba(p.glow, 0.85));
      fillRR(ctx, w / 2 - 0.8, h / 2 - 1.0, 1.6, 0.18, 0.08, team);
      break;
    }
    case 'depot': {
      plate();
      line(ctx, 0.6, h - 0.4, w / 2, 0.3, 0.12, p.dark);
      line(ctx, w - 0.6, h - 0.4, w / 2, 0.3, 0.12, p.dark);
      line(ctx, w / 2, h - 0.2, w / 2, 0.3, 0.12, p.dark);
      circle(ctx, w / 2, 0.6, 0.62, p.body);
      circle(ctx, w / 2, 0.6, 0.48, rgba(p.glow, 0.75));
      circle(ctx, w / 2 - 0.15, 0.45, 0.14, 'rgba(255,255,255,0.5)');
      fillRR(ctx, w / 2 - 0.5, 1.3, 1.0, 0.16, 0.06, team);
      break;
    }
    case 'defense': {
      plate();
      crystal(ctx, 0.9, h - 0.6, 0.7, 1.4, p.body, p.glow);
      crystal(ctx, 1.7, h - 0.9, 0.9, 1.9, p.light, p.glow);
      crystal(ctx, 2.3, h - 0.4, 0.6, 1.1, p.body, p.glow);
      fillRR(ctx, 0.4, h - 0.35, w - 0.8, 0.14, 0.06, team);
      break;
    }
    case 'factory': {
      plate();
      dome(w / 2, h / 2 + 0.2, 1.65, 1.3, 1.2, p.body);
      fillRR(ctx, w / 2 - 0.8, h - 0.95, 1.6, 0.7, 0.3, rgba(p.glow, 0.75));
      fillRR(ctx, w / 2 - 1.1, 0.2, 2.2, 0.18, 0.08, team);
      break;
    }
    case 'airbase': {
      plate('#5e5272');
      for (let k = 0; k < 2; k++) {
        const cx = 1 + k * 2;
        const cy = h - 1.2;
        circle(ctx, cx, cy, 0.62, '#4a3f5c');
        ctx.strokeStyle = rgba(p.glow, 0.8);
        ctx.lineWidth = 0.07;
        ctx.beginPath();
        ctx.arc(cx, cy, 0.5, 0, TAU);
        ctx.stroke();
      }
      crystal(ctx, 1.0, 1.1, 0.8, 1.8, p.light, p.glow);
      dome(2.8, 0.9, 0.8, 0.5, 0.6, p.body);
      fillRR(ctx, 2.2, 0.3, 1.2, 0.12, 0.05, team);
      break;
    }
    case 'dropzone': {
      circle(ctx, w / 2, h / 2, 1.45, '#4a3f5c');
      ctx.strokeStyle = rgba(p.glow, 0.7);
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 1.2, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 0.5, 0, TAU);
      ctx.stroke();
      for (const [dx, dy] of [
        [0.35, 0.35],
        [w - 0.35, 0.35],
        [0.35, h - 0.35],
        [w - 0.35, h - 0.35],
      ])
        crystal(ctx, dx, dy, 0.3, 0.7, p.body, p.glow);
      circle(ctx, w / 2, h / 2, 0.22, team);
      break;
    }
    case 'super': {
      plate();
      ctx.strokeStyle = rgba(p.glow, 0.6);
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2 - 0.6, 1.5, 0.5, 0, 0, TAU);
      ctx.stroke();
      crystal(ctx, w / 2, h / 2 + 0.8, 1.0, 3.6, p.light, p.glow);
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2 - 1.6, 1.0, 0.3, 0, 0, TAU);
      ctx.stroke();
      circle(ctx, w / 2, h / 2 + 0.2, 0.2, team);
      break;
    }
    case 'sam': {
      plate();
      crystal(ctx, w / 2, h / 2 + 0.4, 0.55, 1.6, p.light, p.glow);
      circle(ctx, w / 2, h / 2 + 0.55, 0.12, team);
      break;
    }
    case 'arty': {
      plate();
      poly(ctx, [w / 2 - 0.35, h / 2 + 0.5, w / 2 + 0.35, h / 2 + 0.5, w / 2 + 0.2, h / 2 - 1.0, w / 2 - 0.2, h / 2 - 1.0], p.body);
      circle(ctx, w / 2, h / 2 + 0.45, 0.12, team);
      break;
    }
    case 'bunker': {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ell(ctx, w / 2 + 0.1, h / 2 + 0.15, 0.95, 0.8);
      dome(w / 2, h / 2 + 0.1, 0.9, 0.75, 0.7, p.body);
      fillRR(ctx, 0.35, h / 2 - 0.05, w - 0.7, 0.12, 0.05, rgba(p.glow, 0.8));
      fillRR(ctx, w / 2 - 0.4, h - 0.4, 0.8, 0.12, 0.05, team);
      break;
    }
  }
}

function drawMarauderBuilding(ctx: C, key: BuildingKey, w: number, h: number, team: string): void {
  const p = pal('marauder');
  if (key === 'fortress') {
    fillRR(ctx, 0, 0, w, h, 0.1, '#8b7550');
    // scrap walls
    const plate = (x: number, y: number, ww: number, hh: number, hgt: number, i: number) => box(ctx, x, y, ww, hh, hgt, i % 2 ? p.body : shade(p.body, -0.12), shade(p.body, -0.4), 0.02);
    plate(0, 0.3, w, 0.45, 0.6, 0);
    plate(0, 0.3, 0.45, h - 0.3, 0.6, 1);
    plate(w - 0.45, 0.3, 0.45, h - 0.3, 0.6, 1);
    plate(0, h - 0.45, 1.4, 0.45, 0.6, 2);
    plate(w - 1.4, h - 0.45, 1.4, 0.45, 0.6, 3);
    box(ctx, 1.1, 1.3, 1.8, 1.6, 1.4, shade(p.body, 0.1), shade(p.body, -0.35), 0.04);
    for (let k = 0; k < 5; k++) line(ctx, 1.2 + k * 0.4, 1.3 - 1.4, 1.2 + k * 0.4, 1.3 - 1.8, 0.05, '#3d3122');
    fillRR(ctx, 1.1, 1.3 - 1.4 + 0.4, 1.8, 0.16, 0.02, team);
  } else {
    // watchtower
    for (const [lx, ly] of [
      [0.35, h - 0.2],
      [w - 0.35, h - 0.2],
    ])
      line(ctx, lx, ly, w / 2 + (lx < w / 2 ? -0.45 : 0.45), h / 2 - 1.0, 0.08, '#4a3a28');
    box(ctx, 0.2, h / 2 - 0.9, w - 0.4, 0.9, 0.3, p.body, shade(p.body, -0.4), 0.03);
    fillRR(ctx, 0.2, h / 2 - 0.9 - 0.3 + 0.05, w - 0.4, 0.12, 0.02, team);
  }
}
