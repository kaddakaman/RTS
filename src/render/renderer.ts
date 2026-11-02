// Draws the battlefield as seen by one player: terrain, structures, units,
// projectiles, effects, fog of war and the interface overlays that live in
// the world (selection rings, health bars, placement ghosts, cursor).

import { clamp, dist, hash2 } from '../core/math';
import { FACTIONS, TEAM_COLORS, type BuildingKey, type FactionId } from '../data/defs';
import type { Building, FxEvent, Pile, Projectile, Thing, Unit } from '../sim/entities';
import { NEUTRAL, type World } from '../sim/world';
import { rgba, shade } from './color';
import { altitude, buildingSprite, drawBuilding, drawTeamRing, drawUnit, drawUnitShadow } from './sprites';
import { CHUNK, renderTerrain, type TerrainArt } from './terrain';

export interface Marker {
  x: number;
  y: number;
  kind: 'move' | 'attack' | 'gather' | 'build' | 'board' | 'rally' | 'error';
  t: number;
}

export interface ViewState {
  viewer: number;
  selected: Unit[];
  building: Building | null;
  hover: Thing | null;
  /** Cursor in world coordinates (gamepad reticle or mouse). */
  cursor: { x: number; y: number } | null;
  cursorStyle: 'reticle' | 'pointer' | 'none';
  paint: { x: number; y: number; r: number } | null;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  placement: { key: BuildingKey; faction: FactionId; tx: number; ty: number; ok: boolean } | null;
  targeting: { x: number; y: number; r: number } | null;
  markers: Marker[];
  hint: 'attack' | 'gather' | 'build' | 'board' | 'select' | 'move' | '';
}

interface Particle {
  kind: 'puff' | 'spark' | 'fire' | 'smoke' | 'ring' | 'flash' | 'debris' | 'text' | 'glow';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  color: string;
  text?: string;
}

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
  max: number;
  width: number;
  color: string;
  glow?: string;
}

interface Decal {
  x: number;
  y: number;
  r: number;
  life: number;
  kind: 'scorch' | 'smear';
}

interface Anim {
  kind: 'plane' | 'teleport' | 'superwarn' | 'superhit' | 'recon';
  x: number;
  y: number;
  t: number;
  dur: number;
  faction: FactionId;
  r: number;
  ax?: number;
  ay?: number;
}

const MAX_PARTICLES = 700;

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  cam = { x: 48, y: 48, zoom: 34 };
  w = 0;
  h = 0;
  dpr = 1;
  maxDpr = 2;
  private art: TerrainArt;
  private fog: HTMLCanvasElement;
  private fogCtx: CanvasRenderingContext2D;
  private fogImg: ImageData;
  private particles: Particle[] = [];
  private lines: Line[] = [];
  private decals: Decal[] = [];
  private anims: Anim[] = [];
  private shakeAmt = 0;
  time = 0;
  /** Called for every effect the viewer can see (for sound). */
  onVisibleFx: ((e: FxEvent, distToCam: number) => void) | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly world: World,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.art = renderTerrain(world.map);
    this.fog = document.createElement('canvas');
    this.fog.width = world.map.w;
    this.fog.height = world.map.h;
    this.fogCtx = this.fog.getContext('2d')!;
    this.fogImg = this.fogCtx.createImageData(world.map.w, world.map.h);
    this.resize();
  }

  get minimapBase(): HTMLCanvasElement {
    return this.art.minimap;
  }

  resize(): void {
    const dpr = Math.min(this.maxDpr, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.cam.x + (sx - this.w / 2) / this.cam.zoom, y: this.cam.y + (sy - this.h / 2) / this.cam.zoom };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.cam.x) * this.cam.zoom + this.w / 2, y: (wy - this.cam.y) * this.cam.zoom + this.h / 2 };
  }

  clampCamera(): void {
    const m = this.world.map;
    const hw = this.w / 2 / this.cam.zoom;
    const hh = this.h / 2 / this.cam.zoom;
    this.cam.x = clamp(this.cam.x, Math.min(hw - 2, m.w / 2), Math.max(m.w - hw + 2, m.w / 2));
    this.cam.y = clamp(this.cam.y, Math.min(hh - 2, m.h / 2), Math.max(m.h - hh + 2, m.h / 2));
  }

  shake(a: number): void {
    this.shakeAmt = Math.min(1.2, Math.max(this.shakeAmt, a));
  }

  // ---------------------------------------------------------------- effects intake

  addFx(events: FxEvent[], viewer: number): void {
    const w = this.world;
    for (const e of events) {
      const vis = e.k === 'super' || w.tileVisible(viewer, e.x, e.y) || ('x2' in e && w.tileVisible(viewer, e.x2, e.y2));
      if (!vis) continue;
      this.onVisibleFx?.(e, dist(e.x, e.y, this.cam.x, this.cam.y));
      switch (e.k) {
        case 'shot':
          this.shotFx(e);
          break;
        case 'impact':
          this.impactFx(e.fx, e.x, e.y, e.size, e.air);
          break;
        case 'explode':
          this.explosion(e.x, e.y, e.size, e.air);
          break;
        case 'death':
          for (let i = 0; i < 4; i++) this.spawn('puff', e.x + rnd(0.3), e.y + rnd(0.3), 0, rnd(0.3), rnd(0.3), 0.4, 0.5, 0.18, 0.4, e.faction === 'sythari' ? 'rgba(90,240,220,0.5)' : 'rgba(120,40,30,0.55)');
          this.decals.push({ x: e.x, y: e.y, r: 0.25, life: 40, kind: 'smear' });
          break;
        case 'text':
          this.particles.push({ kind: 'text', x: e.x, y: e.y, z: 0.5, vx: 0, vy: 0, vz: 0.8, life: 1.6, max: 1.6, size: 0.5, grow: 0, color: e.color, text: e.text });
          break;
        case 'drop':
          if (e.faction === 'sythari') this.anims.push({ kind: 'teleport', x: e.x, y: e.y, t: 0, dur: 3.5, faction: e.faction, r: 1.5 });
          else {
            const a = hash2(Math.floor(e.x), Math.floor(this.time * 10), 3) * Math.PI * 2;
            this.anims.push({ kind: 'plane', x: e.x, y: e.y, t: 0, dur: 3.5, faction: e.faction, r: 1.5, ax: Math.cos(a), ay: Math.sin(a) });
          }
          break;
        case 'super':
          if (e.phase === 'warn') this.anims.push({ kind: 'superwarn', x: e.x, y: e.y, t: 0, dur: 3.2, faction: e.faction, r: e.radius });
          else {
            this.anims.push({ kind: 'superhit', x: e.x, y: e.y, t: 0, dur: 2.2, faction: e.faction, r: e.radius });
            for (let i = 0; i < 14; i++) {
              const a = Math.random() * Math.PI * 2;
              const d = Math.random() * e.radius;
              this.explosion(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, 1 + Math.random() * 1.5, false);
            }
            this.decals.push({ x: e.x, y: e.y, r: e.radius * 0.9, life: 120, kind: 'scorch' });
            this.shake(1.2);
          }
          break;
        case 'recon':
          this.anims.push({ kind: 'recon', x: e.x, y: e.y, t: 0, dur: 1.2, faction: 'coalition', r: e.r });
          break;
        case 'build':
          for (let i = 0; i < 3; i++) this.spawn('spark', e.x, e.y, 0.2, rnd(1.5), rnd(1.5), 1.5, 0.35, 0.05, 0, '#ffd34a');
          break;
        case 'grenade':
          break;
      }
    }
  }

  private spawn(kind: Particle['kind'], x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grow: number, color: string): void {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push({ kind, x, y, z, vx, vy, vz, life, max: life, size, grow, color });
  }

  private shotFx(e: Extract<FxEvent, { k: 'shot' }>): void {
    const pal = FACTIONS[e.faction].palette;
    const lift = e.air ? altLift(e) : 0;
    const add = (width: number, color: string, life: number, glow?: string) =>
      this.lines.push({ x1: e.x, y1: e.y, x2: e.x2, y2: e.y2 - lift, life, max: life, width, color, glow });
    switch (e.fx) {
      case 'bullet':
        add(0.035, 'rgba(255,230,150,0.9)', 0.06);
        this.spawn('spark', e.x2, e.y2 - lift, 0.1, rnd(0.6), rnd(0.6), 0.5, 0.15, 0.04, 0, '#ffe08a');
        break;
      case 'sniper':
        add(0.03, 'rgba(255,255,240,0.95)', 0.14);
        break;
      case 'laser':
        add(0.05, rgba(pal.glow, 0.9), 0.08, rgba(pal.glow, 0.3));
        break;
      case 'beam':
        add(0.07, rgba('#ffffff', 0.95), 0.25, rgba(pal.glow, 0.5));
        this.spawn('glow', e.x2, e.y2, 0.1, 0, 0, 0, 0.25, 0.25, 0.4, rgba(pal.glow, 0.6));
        break;
      default:
        // projectile weapons: muzzle flash / launch smoke
        this.spawn('flash', e.x, e.y, 0.1, 0, 0, 0, 0.1, 0.18, 0.5, e.faction === 'sythari' ? rgba(pal.glow, 0.8) : 'rgba(255,210,120,0.9)');
        if (e.fx === 'rocket' || e.fx === 'missile' || e.fx === 'shell' || e.fx === 'arty')
          for (let i = 0; i < 2; i++) this.spawn('smoke', e.x, e.y, 0.1, rnd(0.4), rnd(0.4), 0.2, 0.7, 0.15, 0.4, 'rgba(200,195,180,0.5)');
    }
  }

  private impactFx(fx: string, x: number, y: number, size: number, air: boolean): void {
    if (fx === 'plasma' || fx === 'laser') {
      this.spawn('glow', x, y, air ? 1 : 0.1, 0, 0, 0, 0.3, 0.3 * Math.max(1, size), 1, 'rgba(90,240,220,0.7)');
      for (let i = 0; i < 4; i++) this.spawn('spark', x, y, 0.2, rnd(2), rnd(2), 1, 0.3, 0.05, 0, '#9ffff0');
      if (size > 0.5) this.explosion(x, y, size * 0.6, air);
    } else if (fx === 'bomb' || fx === 'arty' || fx === 'shell' || size > 0.5) {
      this.explosion(x, y, Math.max(0.6, size * 0.8), air);
    } else {
      this.spawn('flash', x, y, air ? 1 : 0.1, 0, 0, 0, 0.12, 0.25, 1.5, 'rgba(255,200,110,0.9)');
      for (let i = 0; i < 3; i++) this.spawn('smoke', x, y, 0.1, rnd(0.5), rnd(0.5), 0.3, 0.5, 0.12, 0.4, 'rgba(120,110,100,0.5)');
    }
  }

  private explosion(x: number, y: number, size: number, air: boolean): void {
    const z = air ? 1 : 0;
    this.spawn('flash', x, y, z, 0, 0, 0, 0.15, size * 0.35, size * 0.6, 'rgba(255,240,200,0.9)');
    const n = Math.min(14, Math.round(5 + size * 4));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = Math.random() * size * 1.4;
      this.spawn('fire', x, y, z, Math.cos(a) * s, Math.sin(a) * s, 0.5, 0.35 + Math.random() * 0.3, size * 0.25, size * 0.4, Math.random() < 0.5 ? '#ffb347' : '#ff6a2b');
      if (i % 2 === 0) this.spawn('smoke', x + rnd(size * 0.3), y + rnd(size * 0.3), z, Math.cos(a) * s * 0.4, Math.sin(a) * s * 0.4, 0.6, 1.0 + Math.random() * 0.8, size * 0.18, size * 0.3, 'rgba(70,64,58,0.4)');
    }
    for (let i = 0; i < Math.min(8, n); i++) this.spawn('debris', x, y, z + 0.1, rnd(3) * size, rnd(3) * size, 2 + Math.random() * 2, 0.8, 0.05, 0, '#3a332a');
    if (!air) this.decals.push({ x, y, r: size * 0.55, life: 60, kind: 'scorch' });
    if (this.decals.length > 120) this.decals.splice(0, this.decals.length - 120);
    const d = dist(x, y, this.cam.x, this.cam.y);
    if (d < 14) this.shake(Math.min(0.6, size * 0.12) * (1 - d / 14));
  }

  // ---------------------------------------------------------------- frame

  draw(view: ViewState, dt: number): void {
    this.time += dt;
    this.resize();
    const ctx = this.ctx;
    const { w, h, dpr } = this;
    const z = this.cam.zoom;
    const world = this.world;
    const viewer = view.viewer;
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 1.5);
    const sx = this.shakeAmt > 0.01 ? rnd(this.shakeAmt * 0.25) : 0;
    const sy = this.shakeAmt > 0.01 ? rnd(this.shakeAmt * 0.25) : 0;
    const camX = this.cam.x + sx;
    const camY = this.cam.y + sy;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (w / 2 - camX * z), dpr * (h / 2 - camY * z));

    // visible world rect
    const x0 = camX - w / 2 / z - 1;
    const x1 = camX + w / 2 / z + 1;
    const y0 = camY - h / 2 / z - 1;
    const y1 = camY + h / 2 / z + 2.5;
    const inView = (x: number, y: number, pad = 1) => x > x0 - pad && x < x1 + pad && y > y0 - pad && y < y1 + pad;

    // terrain
    ctx.imageSmoothingEnabled = true;
    for (let cy = 0; cy < this.art.rows; cy++)
      for (let cx = 0; cx < this.art.cols; cx++) {
        const wx = cx * CHUNK;
        const wy = cy * CHUNK;
        if (wx > x1 || wy > y1 || wx + CHUNK < x0 || wy + CHUNK < y0) continue;
        ctx.drawImage(this.art.chunks[cy * this.art.cols + cx], wx, wy, CHUNK + 0.02, CHUNK + 0.02);
      }

    // decals
    for (const d of this.decals) {
      d.life -= dt;
      if (!inView(d.x, d.y, d.r)) continue;
      const a = Math.min(1, d.life / 10);
      ctx.fillStyle = d.kind === 'scorch' ? `rgba(30,22,16,${0.35 * a})` : `rgba(70,20,15,${0.3 * a})`;
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, d.r, d.r * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    this.decals = this.decals.filter((d) => d.life > 0);

    // Marauder territories
    for (const c of world.camps) {
      if (!c.zone.active) continue;
      const zz = c.zone;
      if (!inView(zz.cx, zz.cy, zz.r)) continue;
      ctx.fillStyle = 'rgba(255,120,40,0.05)';
      ctx.beginPath();
      ctx.arc(zz.cx, zz.cy, zz.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,140,50,0.55)';
      ctx.lineWidth = 0.1;
      ctx.setLineDash([0.6, 0.4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // supply caches
    for (const p of world.piles) {
      if (!inView(p.x, p.y, 2) || !world.tileExplored(viewer, p.x, p.y)) continue;
      drawPile(ctx, p, view.hover === p);
    }

    // rally line and selection under things
    if (view.building && view.building.rally && view.building.owner === viewer) {
      const b = view.building;
      ctx.strokeStyle = 'rgba(120,255,140,0.7)';
      ctx.lineWidth = 0.06;
      ctx.setLineDash([0.3, 0.2]);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.rally!.x, b.rally!.y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawFlagMarker(ctx, b.rally!.x, b.rally!.y, '#7dff8c');
    }

    // ghosts of remembered enemy buildings
    const pl = world.players[viewer];
    for (const g of pl.ghosts.values()) {
      const b = world.byId.get(g.id) as Building | undefined;
      if (b && !b.dead && world.visibleTo(b, viewer)) continue;
      if (!inView(g.tx + g.w / 2, g.ty + g.h / 2, 4)) continue;
      ctx.save();
      ctx.globalAlpha = 0.6;
      drawBuilding(ctx, g, TEAM_COLORS[g.owner] ?? '#888', this.time);
      ctx.restore();
    }

    // buildings + ground units, sorted by their base for overlap
    const drawList: { y: number; e: Unit | Building }[] = [];
    for (const b of world.buildings) {
      if (b.dead || !inView(b.x, b.y, 4)) continue;
      if (b.owner !== viewer && !world.visibleTo(b, viewer)) continue;
      drawList.push({ y: b.ty + b.h, e: b });
    }
    const air: Unit[] = [];
    const selected = new Set(view.selected);
    for (const u of world.units) {
      if (u.dead || u.container || !inView(u.x, u.y, 2)) continue;
      if (!world.visibleTo(u, viewer)) continue;
      if (u.air) air.push(u);
      else drawList.push({ y: u.y, e: u });
    }
    drawList.sort((a, b) => a.y - b.y);

    // selection rings first (under everything)
    for (const it of drawList) {
      const e = it.e;
      if (e.kind === 'unit') {
        if (selected.has(e)) ring(ctx, e.x, e.y + 0.05, (e.def.members ? 0.68 : e.radius) + 0.08, '#6dff7a', 0.07);
        else if (view.hover === e) ring(ctx, e.x, e.y + 0.05, (e.def.members ? 0.68 : e.radius) + 0.08, e.owner === viewer ? 'rgba(255,255,255,0.8)' : '#ff5a4a', 0.05);
        drawTeamRing(ctx, e, teamColor(e.owner));
      } else if (view.building === e || view.hover === e) {
        ctx.strokeStyle = view.building === e ? '#6dff7a' : e.owner === viewer ? 'rgba(255,255,255,0.8)' : '#ff5a4a';
        ctx.lineWidth = 0.07;
        ctx.strokeRect(e.tx - 0.1, e.ty - 0.1, e.w + 0.2, e.h + 0.2);
      }
    }
    for (const it of drawList) if (it.e.kind === 'unit') drawUnitShadow(ctx, it.e);
    for (const it of drawList) {
      const e = it.e;
      if (e.kind === 'unit') drawUnit(ctx, e, teamColor(e.owner), this.time);
      else {
        drawBuilding(ctx, e, teamColor(e.owner), this.time, e);
        this.buildingSmoke(e, dt);
      }
    }

    // projectiles
    for (const p of world.projectiles) {
      if (!inView(p.x, p.y, 1) || !world.tileVisible(viewer, p.x, p.y)) continue;
      this.drawProjectile(ctx, p, dt);
    }

    // aircraft on top
    for (const u of air) drawUnitShadow(ctx, u);
    for (const u of air) {
      if (selected.has(u)) ring(ctx, u.x, u.y - altitude(u), u.radius + 0.1, '#6dff7a', 0.07);
      else if (view.hover === u) ring(ctx, u.x, u.y - altitude(u), u.radius + 0.1, u.owner === viewer ? 'rgba(255,255,255,0.8)' : '#ff5a4a', 0.05);
      drawUnit(ctx, u, teamColor(u.owner), this.time);
    }

    this.drawParticles(ctx, dt, inView);
    this.drawAnims(ctx, dt);

    // fog of war
    if (!world.reveal) {
      this.updateFog(viewer);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.fog, 0, 0, world.map.w, world.map.h);
      // dark border beyond the map
      ctx.fillStyle = '#0b0f14';
      ctx.fillRect(-50, -50, world.map.w + 100, 50);
      ctx.fillRect(-50, world.map.h, world.map.w + 100, 50);
      ctx.fillRect(-50, 0, 50, world.map.h);
      ctx.fillRect(world.map.w, 0, 50, world.map.h);
    }

    // health bars
    for (const it of drawList) {
      const e = it.e;
      const show = selected.has(e as Unit) || view.building === e || view.hover === e || e.hp < e.maxHp;
      if (!show) continue;
      if (e.kind === 'unit') healthBar(ctx, e, 0);
      else buildingBar(ctx, e);
    }
    for (const u of air) if (selected.has(u) || view.hover === u || u.hp < u.maxHp) healthBar(ctx, u, altitude(u));
    for (const b of world.buildings) {
      // keep production progress visible on our own buildings
      if (b.dead || b.owner !== viewer || !b.built || !b.queue.length || !inView(b.x, b.y, 3)) continue;
      const q = b.queue[0];
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(b.tx + 0.2, b.ty + b.h + 0.08, b.w - 0.4, 0.14);
      ctx.fillStyle = '#4ad6ff';
      ctx.fillRect(b.tx + 0.22, b.ty + b.h + 0.1, (b.w - 0.44) * Math.min(1, q.t / q.total), 0.1);
    }

    // placement ghost
    if (view.placement) {
      const pg = view.placement;
      const def = FACTIONS[pg.faction].buildings[pg.key]!;
      ctx.fillStyle = pg.ok ? 'rgba(80,255,120,0.25)' : 'rgba(255,70,60,0.3)';
      ctx.fillRect(pg.tx, pg.ty, def.w, def.h);
      ctx.save();
      ctx.globalAlpha = 0.6;
      const spr = buildingSprite(pg.faction, pg.key, teamColor(viewer));
      ctx.drawImage(spr, pg.tx - 0.5, pg.ty - 2.2, spr.width / 32, spr.height / 32);
      ctx.restore();
      ctx.strokeStyle = pg.ok ? '#6dff7a' : '#ff5a4a';
      ctx.lineWidth = 0.07;
      ctx.strokeRect(pg.tx, pg.ty, def.w, def.h);
      if (def.nearPile) {
        ctx.strokeStyle = 'rgba(255,220,80,0.4)';
        ctx.setLineDash([0.3, 0.3]);
        for (const p of world.piles) {
          if (p.amount <= 0 || dist(p.x, p.y, pg.tx + def.w / 2, pg.ty + def.h / 2) > 14) continue;
          ctx.beginPath();
          ctx.arc(p.x, p.y, def.nearPile + 1.2, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
    }

    // superweapon targeting
    if (view.targeting) {
      const t = view.targeting;
      const pulse = 0.5 + Math.sin(this.time * 6) * 0.5;
      ctx.strokeStyle = `rgba(255,60,40,${0.5 + pulse * 0.4})`;
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(t.x - t.r - 0.5, t.y);
      ctx.lineTo(t.x + t.r + 0.5, t.y);
      ctx.moveTo(t.x, t.y - t.r - 0.5);
      ctx.lineTo(t.x, t.y + t.r + 0.5);
      ctx.stroke();
    }

    // command markers
    for (const m of view.markers) {
      const k = m.t / 0.7;
      const col = { move: '#6dff7a', attack: '#ff5a4a', gather: '#ffd34a', build: '#4ad6ff', board: '#7ab8ff', rally: '#6dff7a', error: '#ff5a4a' }[m.kind];
      ctx.strokeStyle = col;
      ctx.globalAlpha = Math.max(0, 1 - k);
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 0.25 + k * 0.6, 0, Math.PI * 2);
      ctx.stroke();
      if (m.kind === 'attack' || m.kind === 'error') {
        ctx.beginPath();
        ctx.moveTo(m.x - 0.3, m.y - 0.3);
        ctx.lineTo(m.x + 0.3, m.y + 0.3);
        ctx.moveTo(m.x + 0.3, m.y - 0.3);
        ctx.lineTo(m.x - 0.3, m.y + 0.3);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // paint-select brush
    if (view.paint) {
      ctx.fillStyle = 'rgba(110,255,130,0.12)';
      ctx.strokeStyle = 'rgba(110,255,130,0.8)';
      ctx.lineWidth = 0.06;
      ctx.beginPath();
      ctx.arc(view.paint.x, view.paint.y, view.paint.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // ---- screen space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (view.box) {
      const b = view.box;
      ctx.strokeStyle = '#6dff7a';
      ctx.fillStyle = 'rgba(110,255,130,0.1)';
      ctx.lineWidth = 1.5;
      ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    if (view.cursor && view.cursorStyle === 'reticle') {
      const s = this.worldToScreen(view.cursor.x, view.cursor.y);
      const col = { attack: '#ff5a4a', gather: '#ffd34a', build: '#4ad6ff', board: '#7ab8ff', select: '#6dff7a', move: '#ffffff', '': 'rgba(255,255,255,0.85)' }[view.hint];
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 4;
      reticle(ctx, s.x, s.y, 13);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      reticle(ctx, s.x, s.y, 13);
    }
  }

  private updateFog(viewer: number): void {
    const pl = this.world.players[viewer];
    const vis = pl.vis;
    const ex = pl.explored;
    const d = this.fogImg.data;
    for (let i = 0; i < vis.length; i++) {
      const j = i * 4;
      d[j] = 6;
      d[j + 1] = 8;
      d[j + 2] = 14;
      d[j + 3] = vis[i] ? 0 : ex[i] ? 72 : 255;
    }
    this.fogCtx.putImageData(this.fogImg, 0, 0);
  }

  private buildingSmoke(b: Building, dt: number): void {
    if (!b.built) return;
    const f = b.hp / b.maxHp;
    if (f > 0.6) return;
    if (Math.random() < dt * (f < 0.3 ? 10 : 4)) {
      const x = b.tx + Math.random() * b.w;
      const y = b.ty + Math.random() * b.h - 0.6;
      this.spawn('smoke', x, y, 0.3, rnd(0.2), -0.1, 0.6, 1.6, 0.15, 0.4, 'rgba(40,38,36,0.4)');
      if (f < 0.3) this.spawn('fire', x, y, 0.2, rnd(0.2), 0, 0.4, 0.5, 0.15, 0.1, '#ff8a3c');
    }
  }

  private drawProjectile(ctx: CanvasRenderingContext2D, p: Projectile, dt: number): void {
    const pal = FACTIONS[p.faction].palette;
    const k = Math.min(1, p.t / p.dur);
    const ang = Math.atan2(p.ty - p.sy, p.tx - p.sx);
    switch (p.fx) {
      case 'rocket':
      case 'missile': {
        const lift = p.toAir ? k * 0.9 : 0;
        ctx.save();
        ctx.translate(p.x, p.y - lift);
        ctx.rotate(ang);
        ctx.fillStyle = p.fx === 'missile' ? '#e8e4d8' : '#3d3d36';
        ctx.fillRect(-0.15, -0.035, 0.3, 0.07);
        ctx.fillStyle = 'rgba(255,170,60,0.95)';
        ctx.beginPath();
        ctx.arc(-0.17, 0, 0.05 + Math.random() * 0.02, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        if (Math.random() < dt * 40) this.spawn('smoke', p.x, p.y - lift, 0, rnd(0.1), rnd(0.1), 0.1, 0.6, 0.06, 0.25, 'rgba(210,205,195,0.5)');
        break;
      }
      case 'plasma':
      case 'laser': {
        const lift = p.toAir ? k * 0.9 : 0;
        ctx.fillStyle = rgba(pal.glow, 0.35);
        ctx.beginPath();
        ctx.arc(p.x, p.y - lift, 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#e8fffb';
        ctx.beginPath();
        ctx.arc(p.x, p.y - lift, 0.08, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'shell': {
        ctx.fillStyle = '#2a2620';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 0.06, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'arty': {
        const d = Math.hypot(p.tx - p.sx, p.ty - p.sy);
        const hgt = Math.sin(k * Math.PI) * Math.min(4, d * 0.3);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, 0.08, 0.05, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = p.faction === 'sythari' ? pal.glow : '#2a2620';
        ctx.beginPath();
        ctx.arc(p.x, p.y - hgt, p.damage > 90 ? 0.1 : 0.07, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'bomb': {
        const hgt = (1 - k) * 1.3;
        for (let i = -1; i <= 1; i++) {
          ctx.fillStyle = p.faction === 'sythari' ? pal.glow : '#2a2620';
          ctx.beginPath();
          ctx.ellipse(p.x + Math.cos(ang + Math.PI / 2) * i * 0.3, p.y - hgt + Math.sin(ang + Math.PI / 2) * i * 0.3, 0.1, 0.07, ang, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D, dt: number, inView: (x: number, y: number, pad?: number) => boolean): void {
    // tracer lines
    for (const l of this.lines) {
      l.life -= dt;
      const a = Math.max(0, l.life / l.max);
      if (l.glow) {
        ctx.strokeStyle = l.glow;
        ctx.globalAlpha = a;
        ctx.lineWidth = l.width * 3;
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
      }
      ctx.strokeStyle = l.color;
      ctx.globalAlpha = a;
      ctx.lineWidth = l.width;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.lines = this.lines.filter((l) => l.life > 0);

    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.kind === 'debris') p.vz -= 9 * dt;
      if (p.z < 0) {
        p.z = 0;
        p.vz = 0;
        p.vx *= 0.5;
        p.vy *= 0.5;
      }
      p.vx *= 1 - dt * 2;
      p.vy *= 1 - dt * 2;
      if (!inView(p.x, p.y, 2)) continue;
      const k = 1 - p.life / p.max;
      const a = Math.max(0, p.life / p.max);
      const r = p.size + p.grow * k;
      if (p.kind === 'text') {
        ctx.save();
        ctx.globalAlpha = Math.min(1, a * 2);
        ctx.font = `bold ${p.size}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.lineWidth = 0.08;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(p.text!, p.x, p.y - p.z);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text!, p.x, p.y - p.z);
        ctx.restore();
        continue;
      }
      ctx.globalAlpha = p.kind === 'smoke' || p.kind === 'puff' ? a * 0.9 : a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y - p.z, Math.max(0.01, r), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  private drawAnims(ctx: CanvasRenderingContext2D, dt: number): void {
    for (const a of this.anims) {
      a.t += dt;
      const k = a.t / a.dur;
      switch (a.kind) {
        case 'plane': {
          // cargo plane passes over and drops a crate under a parachute
          const px = a.x + a.ax! * (k - 0.45) * 30;
          const py = a.y + a.ay! * (k - 0.45) * 30 - 2.2;
          ctx.fillStyle = 'rgba(0,0,0,0.18)';
          ctx.beginPath();
          ctx.ellipse(px + 0.8, py + 2.6, 1.3, 0.5, Math.atan2(a.ay!, a.ax!), 0, Math.PI * 2);
          ctx.fill();
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(Math.atan2(a.ay!, a.ax!));
          ctx.fillStyle = '#7d8468';
          ctx.fillRect(-1.1, -0.22, 2.2, 0.44);
          ctx.fillRect(-0.2, -1.4, 0.5, 2.8);
          ctx.fillRect(-1.1, -0.6, 0.3, 1.2);
          ctx.restore();
          if (k > 0.45) {
            const ck = Math.min(1, (k - 0.45) / 0.5);
            const cy = a.y - 2.2 * (1 - ck);
            ctx.strokeStyle = 'rgba(240,240,230,0.8)';
            ctx.lineWidth = 0.03;
            ctx.beginPath();
            ctx.moveTo(a.x - 0.35, cy - 0.9);
            ctx.lineTo(a.x, cy);
            ctx.lineTo(a.x + 0.35, cy - 0.9);
            ctx.stroke();
            ctx.fillStyle = '#e9e4d2';
            ctx.beginPath();
            ctx.ellipse(a.x, cy - 1.0, 0.55, 0.3, 0, Math.PI, 0);
            ctx.fill();
            ctx.fillStyle = '#9a7438';
            ctx.fillRect(a.x - 0.25, cy - 0.2, 0.5, 0.4);
          }
          break;
        }
        case 'teleport': {
          const g = FACTIONS.sythari.palette.glow;
          const inten = Math.sin(Math.min(1, k) * Math.PI);
          ctx.fillStyle = rgba(g, 0.35 * inten);
          ctx.fillRect(a.x - 0.6 * inten, a.y - 20, 1.2 * inten, 20);
          ctx.fillStyle = rgba('#ffffff', 0.6 * inten);
          ctx.fillRect(a.x - 0.15 * inten, a.y - 20, 0.3 * inten, 20);
          ctx.beginPath();
          ctx.ellipse(a.x, a.y, 1.2 * inten, 0.6 * inten, 0, 0, Math.PI * 2);
          ctx.fill();
          if (Math.random() < dt * 20) this.spawn('spark', a.x + rnd(0.8), a.y, 0, rnd(0.3), 0, 2, 0.6, 0.05, 0, g);
          break;
        }
        case 'superwarn': {
          const pulse = 0.5 + Math.sin(a.t * 14) * 0.5;
          ctx.strokeStyle = `rgba(255,50,40,${0.4 + pulse * 0.5})`;
          ctx.lineWidth = 0.15;
          ctx.beginPath();
          ctx.arc(a.x, a.y, a.r * (1 - k * 0.3), 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = `rgba(255,50,40,${0.08 + pulse * 0.08})`;
          ctx.fill();
          if (a.faction === 'sythari') {
            ctx.fillStyle = rgba(FACTIONS.sythari.palette.glow, 0.2 * k);
            ctx.beginPath();
            ctx.arc(a.x, a.y, a.r * k, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.strokeStyle = `rgba(255,220,120,${0.3 + k * 0.5})`;
            ctx.lineWidth = 0.05 + k * 0.15;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(a.x - 6, a.y - 30);
            ctx.stroke();
          }
          break;
        }
        case 'superhit': {
          const inten = 1 - k;
          const col = a.faction === 'sythari' ? FACTIONS.sythari.palette.glow : '#ffe6a0';
          ctx.fillStyle = rgba(col, 0.6 * inten);
          ctx.beginPath();
          ctx.arc(a.x, a.y, a.r * (0.6 + k * 1.2), 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = rgba('#ffffff', 0.8 * inten);
          ctx.lineWidth = 0.3 * inten;
          ctx.beginPath();
          ctx.arc(a.x, a.y, a.r * (0.4 + k * 2.2), 0, Math.PI * 2);
          ctx.stroke();
          if (a.faction !== 'sythari' && k < 0.4) {
            ctx.fillStyle = rgba('#fff8e0', 0.9 * (1 - k / 0.4));
            ctx.fillRect(a.x - 0.8, a.y - 40, 1.6, 40);
          }
          break;
        }
        case 'recon': {
          ctx.strokeStyle = `rgba(120,220,255,${0.7 * (1 - k)})`;
          ctx.lineWidth = 0.12;
          ctx.beginPath();
          ctx.arc(a.x, a.y, a.r * k, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
      }
    }
    this.anims = this.anims.filter((a) => a.t < a.dur);
  }
}

// ---------------------------------------------------------------- helpers

export function teamColor(owner: number): string {
  return TEAM_COLORS[owner] ?? '#999';
}

function rnd(s: number): number {
  return (Math.random() - 0.5) * 2 * s;
}

function altLift(e: { x: number; y: number }): number {
  void e;
  return 0.9;
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, w: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.75, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function reticle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.moveTo(x - r - 6, y);
  ctx.lineTo(x - r + 4, y);
  ctx.moveTo(x + r - 4, y);
  ctx.lineTo(x + r + 6, y);
  ctx.moveTo(x, y - r - 6);
  ctx.lineTo(x, y - r + 4);
  ctx.moveTo(x, y + r - 4);
  ctx.lineTo(x, y + r + 6);
  ctx.stroke();
}

function healthBar(ctx: CanvasRenderingContext2D, u: Unit, alt: number): void {
  const r = u.def.members ? 0.62 : u.radius;
  const w = Math.max(0.8, r * 1.8);
  const x = u.x - w / 2;
  const y = u.y - alt - r - 0.42;
  const f = Math.max(0, u.hp / u.maxHp);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x - 0.03, y - 0.03, w + 0.06, 0.16);
  ctx.fillStyle = f > 0.6 ? '#5bea5b' : f > 0.3 ? '#f2d03b' : '#f2533b';
  ctx.fillRect(x, y, w * f, 0.1);
  if (u.def.members) {
    // one pip per squad member
    const n = u.members;
    const alive = u.alive;
    const pw = Math.min(0.18, (w - 0.05 * (n - 1)) / n);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i < alive ? (u.medic && i === n - 1 ? '#ffffff' : '#d8f0ff') : 'rgba(80,80,80,0.8)';
      ctx.fillRect(x + i * (pw + 0.05), y - 0.16, pw, 0.1);
    }
  }
  if (u.def.bomber && u.ammo <= 0) {
    ctx.fillStyle = '#ffb347';
    ctx.font = 'bold 0.3px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('rearming', u.x, y - 0.12);
  }
}

function buildingBar(ctx: CanvasRenderingContext2D, b: Building): void {
  if (!b.built) return;
  const w = b.w - 0.4;
  const x = b.tx + 0.2;
  const y = b.ty - 0.3 - (b.owner === NEUTRAL ? 0.6 : 1.0);
  const f = Math.max(0, b.hp / b.maxHp);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x - 0.03, y - 0.03, w + 0.06, 0.18);
  ctx.fillStyle = f > 0.6 ? '#5bea5b' : f > 0.3 ? '#f2d03b' : '#f2533b';
  ctx.fillRect(x, y, w * f, 0.12);
}

function drawPile(ctx: CanvasRenderingContext2D, p: Pile, hover: boolean): void {
  const f = p.amount / p.max;
  const x = p.tx;
  const y = p.ty;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(x + 0.1, y + 0.15, 2, 2);
  ctx.fillStyle = '#7d6a48';
  ctx.fillRect(x, y, 2, 2);
  if (p.amount <= 0) {
    ctx.strokeStyle = 'rgba(60,50,35,0.6)';
    ctx.lineWidth = 0.05;
    ctx.strokeRect(x + 0.1, y + 0.1, 1.8, 1.8);
    return;
  }
  const n = Math.max(1, Math.ceil(f * 6));
  const spots = [
    [0.1, 1.05],
    [1.05, 1.05],
    [0.1, 0.1],
    [1.05, 0.1],
    [0.55, 0.55],
    [0.55, -0.35],
  ];
  for (let i = 0; i < n; i++) {
    const [sx, sy] = spots[i];
    ctx.fillStyle = shade('#c8963c', -0.05 * (i % 3));
    ctx.fillRect(x + sx, y + sy, 0.85, 0.85);
    ctx.fillStyle = '#e3b351';
    ctx.fillRect(x + sx, y + sy, 0.85, 0.15);
    ctx.strokeStyle = 'rgba(70,45,15,0.8)';
    ctx.lineWidth = 0.04;
    ctx.strokeRect(x + sx, y + sy, 0.85, 0.85);
    ctx.beginPath();
    ctx.moveTo(x + sx + 0.42, y + sy);
    ctx.lineTo(x + sx + 0.42, y + sy + 0.85);
    ctx.stroke();
  }
  if (hover) {
    ctx.strokeStyle = '#ffd34a';
    ctx.lineWidth = 0.07;
    ctx.strokeRect(x - 0.1, y - 0.1, 2.2, 2.2);
  }
}

function drawFlagMarker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - 0.9);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - 0.9);
  ctx.lineTo(x + 0.45, y - 0.75);
  ctx.lineTo(x, y - 0.6);
  ctx.fill();
}
