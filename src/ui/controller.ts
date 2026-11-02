// Turns gamepad / touch / mouse input into selections and orders.
//
// Gamepad scheme (modelled on Halo Wars):
//   Left stick  move the reticle (push it into an edge to scroll)   Right stick  scroll (click: zoom)
//   A           select (tap) / paint-select (hold)           X  command: move / attack / gather / build / board
//   Y           unit ability, or the build menu for builders  B  cancel / deselect
//   LB          select all army on screen (double-tap: whole map)
//   RB          cycle through unit types in the selection
//   LT          zoom out to the tactical view                 RT superweapon
//   D-pad       up: HQ   down: army   left: last alert   right: next production building
//   Start       pause    Back  match stats

import { sfx } from '../core/audio';
import { clamp, dist } from '../core/math';
import { ABILITIES, FACTIONS, unitDef, type BuildingKey, type UnitKey } from '../data/defs';
import type { Command } from '../sim/commands';
import type { Alert, Building, Pile, Thing, Unit } from '../sim/entities';
import type { World } from '../sim/world';
import { BTN, type Input } from '../input/input';
import type { Marker, Renderer, ViewState } from '../render/renderer';
import { altitude } from '../render/sprites';

export interface RadialOption {
  id: string;
  icon: string;
  label: string;
  detail: string;
  cost?: number;
  enabled: boolean;
  reason?: string;
  count?: number;
  progress?: number;
  run: () => void;
}

export interface Radial {
  title: string;
  subtitle: string;
  options: () => RadialOption[];
  index: number;
  /** What B does: close, or go back to a parent menu. */
  back?: () => void;
}

export interface GameHooks {
  world: () => World;
  me: () => number;
  issue: (cmd: Command) => string;
  toast: (text: string, kind?: 'info' | 'error' | 'done' | 'warn') => void;
  pause: () => void;
  stats: () => void;
  alerts: () => Alert[];
}

type Mode = 'normal' | 'radial' | 'place' | 'target' | 'rally';

export class Controller {
  selected: Unit[] = [];
  building: Building | null = null;
  mode: Mode = 'normal';
  radial: Radial | null = null;
  placeKey: BuildingKey | null = null;
  cursor = { x: 48, y: 48 };
  hover: Thing | null = null;
  markers: Marker[] = [];
  paint: { x: number; y: number; r: number } | null = null;
  box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private fullSel: Unit[] | null = null;
  private subIdx = -1;
  private lastA = { t: 0, key: '' };
  private lastLB = 0;
  private prodIdx = 0;
  private zoomBack = 0;
  /** Touch: pointers currently down. */
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; t: number }>();
  private pinch: { d: number; zoom: number; mx: number; my: number } | null = null;
  private touchMoved = false;
  private longPress = false;
  private lastTap = { t: 0, x: 0, y: 0 };
  private mouseDown: { x: number; y: number; button: number } | null = null;
  private mousePos: { x: number; y: number } | null = null;
  private stickyT = 0;
  /** Gamepad reticle position on screen (CSS pixels). */
  padCursor: { x: number; y: number } | null = null;
  enabled = true;

  constructor(
    private r: Renderer,
    private input: Input,
    private hooks: GameHooks,
  ) {
    const c = r.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e, true));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  private get w(): World {
    return this.hooks.world();
  }
  private get me(): number {
    return this.hooks.me();
  }

  // ---------------------------------------------------------------- per-frame

  update(dt: number): void {
    this.markers = this.markers.filter((m) => (m.t += dt) < 0.7);
    this.selected = this.selected.filter((u) => !u.dead && !u.container);
    if (this.building && this.building.dead) this.closeRadial();
    if (this.fullSel) this.fullSel = this.fullSel.filter((u) => !u.dead);
    if (!this.enabled) return;
    const inp = this.input;
    const gp = inp.device === 'gamepad';
    // on a gamepad the reticle moves around the screen; the camera scrolls at the edges
    if (gp) {
      if (!this.padCursor) this.padCursor = { x: this.r.w / 2, y: this.r.h / 2 };
      this.cursor = this.r.screenToWorld(this.padCursor.x, this.padCursor.y);
    } else if (inp.device === 'mouse' && this.mousePos) this.cursor = this.r.screenToWorld(this.mousePos.x, this.mousePos.y);
    this.hover = gp || (inp.device === 'mouse' && this.mousePos) ? this.pick(this.cursor.x, this.cursor.y, gp ? 0.55 : 0.2) : null;
    this.gamepad(dt);
    this.keyboard(dt);
    this.r.clampCamera();
    if (gp && this.padCursor) this.cursor = this.r.screenToWorld(this.padCursor.x, this.padCursor.y);
  }

  /** What's under a world point: a visible unit, a building, or a supply cache. */
  pick(x: number, y: number, slack: number): Thing | null {
    const w = this.w;
    const me = this.me;
    let best: Thing | null = null;
    let bd = Infinity;
    for (const u of w.units) {
      if (u.dead || u.container || !w.visibleTo(u, me)) continue;
      const uy = u.y - altitude(u);
      const r = (u.def.members ? 0.65 : u.radius) + slack;
      const d = dist(x, y, u.x, uy);
      if (d < r && d < bd) {
        bd = d;
        best = u;
      }
    }
    if (best) return best;
    for (const b of w.buildings) {
      if (b.dead || (b.owner !== me && !w.visibleTo(b, me))) continue;
      if (x >= b.tx - 0.1 && x <= b.tx + b.w + 0.1 && y >= b.ty - 0.6 && y <= b.ty + b.h + 0.1) return b;
    }
    for (const p of w.piles) {
      if (p.amount <= 0 || !w.tileExplored(me, p.x, p.y)) continue;
      if (x >= p.tx - 0.2 && x <= p.tx + 2.2 && y >= p.ty - 0.2 && y <= p.ty + 2.2) return p;
    }
    return null;
  }

  view(): ViewState {
    const gp = this.input.device === 'gamepad';
    let placement: ViewState['placement'] = null;
    if (this.mode === 'place' && this.placeKey) {
      const f = this.w.players[this.me].faction;
      const def = FACTIONS[f].buildings[this.placeKey]!;
      const tx = Math.round(this.cursor.x - def.w / 2);
      const ty = Math.round(this.cursor.y - def.h / 2);
      placement = { key: this.placeKey, faction: f, tx, ty, ok: this.w.canPlace(this.me, this.placeKey, tx, ty).ok };
    }
    let targeting: ViewState['targeting'] = null;
    if (this.mode === 'target') {
      const sw = this.w.superweapon(this.me);
      targeting = { x: this.cursor.x, y: this.cursor.y, r: sw?.def.superweapon?.radius ?? 5 };
    }
    return {
      viewer: this.me,
      selected: this.selected,
      building: this.building,
      hover: this.hover,
      cursor: this.cursor,
      cursorStyle: gp ? 'reticle' : 'none',
      paint: this.paint,
      box: this.box,
      placement,
      targeting,
      markers: this.markers,
      hint: this.hint(),
    };
  }

  /** What pressing X / tapping would do right now (colours the reticle). */
  hint(): ViewState['hint'] {
    return this.hintFor(this.hover);
  }

  /** What an order on `h` would do with the current selection. */
  hintFor(h: Thing | null): ViewState['hint'] {
    if (this.mode === 'place' || this.mode === 'target' || this.mode === 'rally') return 'move';
    if (!this.selected.length) return h && h.kind !== 'pile' && h.owner === this.me ? 'select' : '';
    if (!h) return 'move';
    if (h.kind === 'pile') return this.selected.some((u) => u.def.role === 'gatherer') ? 'gather' : 'move';
    if (this.w.hostile(this.me, h.owner) && this.w.visibleTo(h, this.me)) return 'attack';
    if (h.owner === this.me) {
      if (h.kind === 'building' && (!h.built || h.hp < h.maxHp) && this.selected.some((u) => u.def.role === 'builder')) return 'build';
      if (h.kind === 'building' && h.def.garrison && h.built && !h.garrison && this.selected.some((u) => u.def.infantry)) return 'board';
      if (h.kind === 'unit' && this.w.capacityOf(h) > 0 && this.selected.some((u) => u.def.infantry)) return 'board';
      return 'select';
    }
    return 'move';
  }

  // ---------------------------------------------------------------- gamepad

  private gamepad(dt: number): void {
    const inp = this.input;
    if (!inp.padConnected) return;
    const [lx, ly, rx, ry] = inp.axes;
    const cam = this.r.cam;

    if (this.mode === 'radial' && this.radial) {
      // stick picks a slice of the radial menu
      const opts = this.radial.options();
      if (Math.hypot(lx, ly) > 0.55 && opts.length) {
        const a = Math.atan2(ly, lx) + Math.PI / 2;
        const n = opts.length;
        let i = Math.round((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / ((Math.PI * 2) / n)) % n;
        if (i !== this.radial.index) {
          this.radial.index = i;
          sfx('click');
        }
      }
      if (inp.pressed(BTN.RIGHT)) this.radial.index = (this.radial.index + 1) % Math.max(1, opts.length);
      if (inp.pressed(BTN.LEFT)) this.radial.index = (this.radial.index - 1 + opts.length) % Math.max(1, opts.length);
      if (inp.pressed(BTN.A)) this.choose(this.radial.index);
      if (inp.pressed(BTN.X) && this.building) this.cancelQueue();
      if (inp.pressed(BTN.B)) this.back();
      if (inp.pressed(BTN.START)) this.hooks.pause();
      return;
    }

    // left stick moves the reticle, a little "sticky" over things you can select
    const pc = this.padCursor ?? (this.padCursor = { x: this.r.w / 2, y: this.r.h / 2 });
    if (this.hover && this.hover.kind !== 'pile') this.stickyT = 0.15;
    const sticky = this.stickyT > 0 ? 0.5 : 1;
    this.stickyT -= dt;
    const curSpeed = Math.min(this.r.w, this.r.h) * 1.15 * sticky;
    pc.x = clamp(pc.x + lx * Math.abs(lx) * curSpeed * dt, 4, this.r.w - 4);
    pc.y = clamp(pc.y + ly * Math.abs(ly) * curSpeed * dt, 4, this.r.h - 4);
    // pushing the reticle into a screen edge scrolls the map; the right stick scrolls it directly
    const edge = Math.min(this.r.w, this.r.h) * 0.12;
    let ex = 0;
    let ey = 0;
    if (pc.x < edge && lx < -0.1) ex = -(edge - pc.x) / edge;
    else if (pc.x > this.r.w - edge && lx > 0.1) ex = (pc.x - (this.r.w - edge)) / edge;
    if (pc.y < edge && ly < -0.1) ey = -(edge - pc.y) / edge;
    else if (pc.y > this.r.h - edge && ly > 0.1) ey = (pc.y - (this.r.h - edge)) / edge;
    const pan = 20 * (34 / cam.zoom) * dt;
    cam.x += (ex + rx * Math.abs(rx)) * pan;
    cam.y += (ey + ry * Math.abs(ry)) * pan;
    if (inp.pressed(BTN.RS)) {
      // cycle close / normal / far
      const zooms = [46, 34, 24];
      const i = zooms.findIndex((z) => cam.zoom > z - 4);
      cam.zoom = zooms[(i + 1) % zooms.length];
      this.zoomBack = 0;
    }
    if (inp.pressed(BTN.LT)) this.toggleZoom();

    if (this.mode === 'place' || this.mode === 'target' || this.mode === 'rally') {
      if (inp.pressed(BTN.A)) this.confirmAt(this.cursor.x, this.cursor.y);
      if (inp.pressed(BTN.B)) this.cancelMode();
      if (inp.pressed(BTN.START)) this.hooks.pause();
      return;
    }

    // A: tap = select what's under the reticle, hold = paint-select
    if (inp.held(BTN.A) && inp.heldFor(BTN.A) > 0.22) {
      if (!this.paint) this.clearSelection();
      const r = clamp(1 + (inp.heldFor(BTN.A) - 0.22) * 6, 1, 3.2);
      this.paint = { x: this.cursor.x, y: this.cursor.y, r };
      this.paintAt(this.cursor.x, this.cursor.y, r);
    }
    if (inp.released(BTN.A)) {
      if (this.paint) this.paint = null;
      else this.tapSelect(this.hover, false);
    }
    if (inp.pressed(BTN.X)) this.command(this.cursor.x, this.cursor.y, this.hover);
    if (inp.pressed(BTN.Y)) this.ability();
    if (inp.pressed(BTN.B)) this.cancel();
    if (inp.pressed(BTN.LB)) {
      const now = performance.now();
      if (now - this.lastLB < 350) this.selectArmy(true);
      else this.selectArmy(false);
      this.lastLB = now;
    }
    if (inp.pressed(BTN.RB)) this.cycleSubgroup();
    if (inp.pressed(BTN.RT)) this.superweapon();
    if (inp.pressed(BTN.UP)) this.jumpHQ();
    if (inp.pressed(BTN.DOWN)) this.jumpArmy();
    if (inp.pressed(BTN.LEFT)) this.jumpAlert();
    if (inp.pressed(BTN.RIGHT)) this.nextProduction();
    if (inp.pressed(BTN.START)) this.hooks.pause();
    if (inp.pressed(BTN.BACK)) this.hooks.stats();
  }

  // ---------------------------------------------------------------- keyboard

  private keyboard(dt: number): void {
    const inp = this.input;
    const k = inp.keys;
    const cam = this.r.cam;
    let kx = 0;
    let ky = 0;
    if (k.has('w') || k.has('arrowup')) ky -= 1;
    if (k.has('s') || k.has('arrowdown')) ky += 1;
    if (k.has('a') && !k.has('control')) kx -= 1;
    if (k.has('arrowleft')) kx -= 1;
    if (k.has('d') || k.has('arrowright')) kx += 1;
    if (kx || ky) {
      const sp = 20 * (34 / cam.zoom) * dt;
      cam.x += kx * sp;
      cam.y += ky * sp;
    }
    for (const e of inp.keyQueue) {
      const key = e.key.toLowerCase();
      if (this.mode === 'radial' && this.radial) {
        const n = this.radial.options().length;
        if (key === 'escape' || key === 'backspace') this.back();
        else if (key === 'enter') this.choose(this.radial.index);
        else if (key === 'tab') this.radial.index = (this.radial.index + 1) % Math.max(1, n);
        else if (key >= '1' && key <= '9') this.choose(Number(key) - 1);
        else if (key === 'x' && this.building) this.cancelQueue();
        continue;
      }
      switch (key) {
        case 'escape':
          if (this.mode !== 'normal' || this.selected.length) this.cancel();
          else this.hooks.pause();
          break;
        case 'q':
        case 'f':
          this.ability();
          break;
        case 'b':
          this.openBuildMenu();
          break;
        case 'h':
        case ' ':
          this.jumpHQ();
          break;
        case 'e':
          this.selectArmy(e.shiftKey);
          break;
        case 'tab':
          this.cycleSubgroup();
          break;
        case 'r':
          this.superweapon();
          break;
        case 'z':
          this.toggleZoom();
          break;
        case 'g':
          this.jumpAlert();
          break;
        case 'p':
          this.nextProduction();
          break;
        case 'delete':
          if (this.selected.length) this.hooks.issue({ c: 'stop', units: this.ids() });
          break;
      }
    }
    inp.keyQueue = [];
  }

  // ---------------------------------------------------------------- pointer (mouse + touch)

  private onDown(e: PointerEvent): void {
    if (!this.enabled) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() };
    if (e.pointerType === 'touch') {
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 1) {
        this.touchMoved = false;
        this.longPress = false;
        const id = e.pointerId;
        setTimeout(() => {
          const q = this.pointers.get(id);
          if (q && !this.touchMoved && this.pointers.size === 1 && this.mode === 'normal') {
            // long press: start paint-selecting
            this.longPress = true;
            this.clearSelection();
            const wp = this.r.screenToWorld(q.x, q.y);
            this.paint = { x: wp.x, y: wp.y, r: 1.6 };
            this.paintAt(wp.x, wp.y, 1.6);
            navigator.vibrate?.(15);
          }
        }, 380);
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.r.cam.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        this.paint = null;
        this.longPress = false;
      }
      return;
    }
    this.mouseDown = { x: e.clientX, y: e.clientY, button: e.button };
    this.mousePos = { x: e.clientX, y: e.clientY };
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (Math.hypot(p.x - p.sx, p.y - p.sy) > 10) this.touchMoved = true;
      const cam = this.r.cam;
      if (this.pointers.size >= 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        cam.x -= (mx - this.pinch.mx) / cam.zoom;
        cam.y -= (my - this.pinch.my) / cam.zoom;
        this.pinch.mx = mx;
        this.pinch.my = my;
        cam.zoom = clamp((this.pinch.zoom * d) / Math.max(20, this.pinch.d), 16, 64);
        return;
      }
      if (this.longPress && this.paint) {
        const wp = this.r.screenToWorld(p.x, p.y);
        this.paint = { x: wp.x, y: wp.y, r: 1.6 };
        this.paintAt(wp.x, wp.y, 1.6);
        return;
      }
      if (this.mode === 'place' || this.mode === 'target') {
        // the ghost / target follows the finger
        this.cursor = this.r.screenToWorld(p.x, p.y - 40);
        return;
      }
      if (this.touchMoved) {
        cam.x -= dx / cam.zoom;
        cam.y -= dy / cam.zoom;
      }
      return;
    }
    this.mousePos = { x: e.clientX, y: e.clientY };
    if (this.mouseDown) {
      if (this.mouseDown.button === 1) {
        this.r.cam.x -= e.movementX / this.r.cam.zoom;
        this.r.cam.y -= e.movementY / this.r.cam.zoom;
      } else if (this.mouseDown.button === 0 && this.mode === 'normal' && Math.hypot(e.clientX - this.mouseDown.x, e.clientY - this.mouseDown.y) > 6) {
        this.box = { x0: this.mouseDown.x, y0: this.mouseDown.y, x1: e.clientX, y1: e.clientY };
      }
    }
  }

  private onUp(e: PointerEvent, cancelled = false): void {
    if (e.pointerType === 'touch') {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (!p || cancelled) return;
      if (this.longPress) {
        this.longPress = false;
        this.paint = null;
        if (this.selected.length) sfx('select');
        return;
      }
      if (!this.touchMoved && this.pointers.size === 0) this.tap(p.x, p.y);
      else if (this.mode === 'place' || this.mode === 'target') this.cursor = this.r.screenToWorld(p.x, p.y - 40);
      return;
    }
    const md = this.mouseDown;
    this.mouseDown = null;
    if (!md || cancelled) return;
    const wp = this.r.screenToWorld(e.clientX, e.clientY);
    if (md.button === 2) {
      if (this.mode !== 'normal') this.cancelMode();
      else this.command(wp.x, wp.y, this.pick(wp.x, wp.y, 0.2));
      return;
    }
    if (md.button !== 0) return;
    if (this.box) {
      this.boxSelect(this.box, e.shiftKey);
      this.box = null;
      return;
    }
    if (this.mode === 'place' || this.mode === 'target' || this.mode === 'rally') {
      this.confirmAt(wp.x, wp.y);
      return;
    }
    if (this.mode === 'radial') this.closeRadial();
    this.tapSelect(this.pick(wp.x, wp.y, 0.2), e.shiftKey);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const cam = this.r.cam;
    const before = this.r.screenToWorld(e.clientX, e.clientY);
    cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0015), 16, 64);
    const after = this.r.screenToWorld(e.clientX, e.clientY);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
  }

  /** A touch tap: select things, or order the current selection. */
  private tap(sx: number, sy: number): void {
    const wp = this.r.screenToWorld(sx, sy);
    const now = performance.now();
    const dbl = now - this.lastTap.t < 330 && Math.hypot(sx - this.lastTap.x, sy - this.lastTap.y) < 30;
    this.lastTap = { t: now, x: sx, y: sy };
    if (this.mode === 'place' || this.mode === 'target' || this.mode === 'rally') {
      this.cursor = wp;
      this.confirmAt(wp.x, wp.y);
      return;
    }
    if (this.mode === 'radial') {
      this.closeRadial();
      return;
    }
    const h = this.pick(wp.x, wp.y, 0.35);
    const me = this.me;
    if (h && h.kind === 'unit' && h.owner === me) {
      const boarding = this.w.capacityOf(h) > 0 && this.selected.some((u) => u.def.infantry) && !this.selected.includes(h);
      if (boarding) this.command(wp.x, wp.y, h);
      else if (dbl) this.selectType(h.key);
      else this.tapSelect(h, false);
      return;
    }
    if (h && h.kind === 'building' && h.owner === me) {
      // with builders or infantry selected, tapping a building repairs it / mans it
      const hint = this.hintFor(h);
      if (this.selected.length && (hint === 'build' || hint === 'board')) this.command(wp.x, wp.y, h);
      else this.tapSelect(h, false);
      return;
    }
    if (this.selected.length) this.command(wp.x, wp.y, h);
  }

  // ---------------------------------------------------------------- selection

  private ids(units = this.selected): number[] {
    return units.map((u) => u.id);
  }

  clearSelection(): void {
    this.selected = [];
    this.fullSel = null;
    this.subIdx = -1;
    if (this.mode === 'radial') this.closeRadial();
    this.building = null;
  }

  setSelection(units: Unit[]): void {
    this.selected = units;
    this.fullSel = null;
    this.subIdx = -1;
    this.building = null;
    if (this.mode === 'radial') this.closeRadial();
    if (units.length) sfx('select');
  }

  private tapSelect(h: Thing | null, add: boolean): void {
    const me = this.me;
    if (!h || h.kind === 'pile' || h.owner !== me) {
      if (!add && this.input.device === 'mouse') this.clearSelection();
      return;
    }
    if (h.kind === 'building') {
      this.selectBuilding(h);
      return;
    }
    const now = performance.now();
    if (now - this.lastA.t < 350 && this.lastA.key === h.key) {
      this.selectType(h.key);
      this.lastA = { t: 0, key: '' };
      return;
    }
    this.lastA = { t: now, key: h.key };
    if (add) {
      if (this.selected.includes(h)) this.setSelection(this.selected.filter((u) => u !== h));
      else this.setSelection([...this.selected, h]);
    } else this.setSelection([h]);
  }

  private paintAt(x: number, y: number, r: number): void {
    const me = this.me;
    let added = false;
    for (const u of this.w.units) {
      if (u.owner !== me || u.dead || u.container || this.selected.includes(u)) continue;
      if (dist(x, y, u.x, u.y - altitude(u)) <= r) {
        this.selected.push(u);
        added = true;
      }
    }
    if (added) {
      this.building = null;
      this.fullSel = null;
      sfx('click');
    }
  }

  private boxSelect(b: { x0: number; y0: number; x1: number; y1: number }, add: boolean): void {
    const a = this.r.screenToWorld(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1));
    const c = this.r.screenToWorld(Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
    const units = this.w.units.filter((u) => u.owner === this.me && !u.dead && !u.container && u.x >= a.x && u.x <= c.x && u.y - altitude(u) >= a.y && u.y - altitude(u) <= c.y);
    // prefer combat units over workers when both are in the box
    const army = units.filter((u) => u.def.role !== 'builder' && u.def.role !== 'gatherer');
    const pick = army.length ? army : units;
    if (add) this.setSelection([...new Set([...this.selected, ...pick])]);
    else if (pick.length) this.setSelection(pick);
    else this.clearSelection();
  }

  private onScreen(u: Unit): boolean {
    const r = this.r;
    const a = r.screenToWorld(0, 0);
    const b = r.screenToWorld(r.w, r.h);
    return u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y;
  }

  selectType(key: UnitKey): void {
    const units = this.w.units.filter((u) => u.owner === this.me && !u.dead && !u.container && u.key === key && this.onScreen(u));
    this.setSelection(units);
    this.hooks.toast(`${units.length} × ${units[0]?.def.name ?? key}`);
  }

  isArmy(u: Unit): boolean {
    return u.def.role === 'infantry' || u.def.role === 'vehicle' || u.def.role === 'air';
  }

  selectArmy(global: boolean): void {
    const units = this.w.units.filter((u) => u.owner === this.me && !u.dead && !u.container && this.isArmy(u) && (global || this.onScreen(u)));
    this.setSelection(units);
    this.hooks.toast(units.length ? `${global ? 'Whole army' : 'Army on screen'}: ${units.length} units` : global ? 'You have no army' : 'No army on screen');
  }

  cycleSubgroup(): void {
    const base = this.fullSel ?? this.selected;
    const keys = [...new Set(base.map((u) => u.key))];
    if (keys.length < 2) return;
    if (!this.fullSel) this.fullSel = base.slice();
    this.subIdx++;
    if (this.subIdx >= keys.length) {
      this.subIdx = -1;
      this.selected = this.fullSel.slice();
      this.hooks.toast('All selected types');
    } else {
      const k = keys[this.subIdx];
      this.selected = this.fullSel.filter((u) => u.key === k);
      this.hooks.toast(`Subgroup: ${this.selected[0]?.def.name ?? k}`);
    }
    sfx('click');
  }

  selectBuilding(b: Building): void {
    this.selected = [];
    this.fullSel = null;
    this.building = b;
    this.openBuildingRadial(b);
    sfx('select');
  }

  // ---------------------------------------------------------------- orders

  command(x: number, y: number, h: Thing | null): void {
    if (this.mode === 'radial') this.closeRadial();
    if (this.building && !this.selected.length) {
      // with a building selected, X sets its rally point
      if (this.building.def.produces) {
        this.hooks.issue({ c: 'rally', b: this.building.id, x, y });
        this.marker(x, y, 'rally');
        sfx('move');
      }
      return;
    }
    if (!this.selected.length) return;
    const units = this.ids();
    const hint = this.hintFor(h);
    const res = this.hooks.issue({ c: 'smart', units, x, y, hover: h ? h.id : 0 });
    const kind: Marker['kind'] =
      hint === 'attack' ? 'attack' : hint === 'gather' ? 'gather' : hint === 'build' ? 'build' : hint === 'board' ? 'board' : 'move';
    const mx = h && h.kind !== 'unit' ? h.x : x;
    const my = h && h.kind !== 'unit' ? h.y : y;
    this.marker(mx, my, kind);
    sfx(kind === 'attack' ? 'attack' : 'move');
    if (res && !['move', 'attack', 'gather', 'build', 'repair', 'garrison', 'board', 'return'].includes(res)) this.hooks.toast(res, 'error');
  }

  private marker(x: number, y: number, kind: Marker['kind']): void {
    this.markers.push({ x, y, kind, t: 0 });
  }

  ability(): void {
    if (this.building) {
      if (this.building.garrison) this.hooks.issue({ c: 'eject', b: this.building.id });
      return;
    }
    if (!this.selected.length) return;
    if (this.selected.some((u) => u.def.role === 'builder')) {
      this.openBuildMenu();
      return;
    }
    const usable = this.selected.filter((u) => u.def.ability && (u.abilityCd <= 0 || u.def.ability === 'unload' || u.def.ability === 'rearm'));
    if (!usable.length) {
      const withAb = this.selected.find((u) => u.def.ability);
      this.hooks.toast(withAb ? `${ABILITIES[withAb.def.ability!].name} recharging` : 'No special ability', 'error');
      sfx('error');
      return;
    }
    const res = this.hooks.issue({ c: 'ability', units: this.ids(usable) });
    if (res === 'Nothing to use') this.hooks.toast('No target in range', 'error');
    else sfx('click');
  }

  cancel(): void {
    if (this.mode === 'radial') this.back();
    else if (this.mode !== 'normal') this.cancelMode();
    else this.clearSelection();
  }

  private cancelMode(): void {
    if (this.mode === 'rally' && this.building) {
      this.openBuildingRadial(this.building);
      return;
    }
    this.mode = 'normal';
    this.placeKey = null;
  }

  private confirmAt(x: number, y: number): void {
    if (this.mode === 'place' && this.placeKey) {
      const f = this.w.players[this.me].faction;
      const def = FACTIONS[f].buildings[this.placeKey]!;
      const tx = Math.round(x - def.w / 2);
      const ty = Math.round(y - def.h / 2);
      const chk = this.w.canPlace(this.me, this.placeKey, tx, ty);
      if (!chk.ok) {
        this.hooks.toast(chk.reason, 'error');
        sfx('error');
        return;
      }
      const builders = this.selected.filter((u) => u.def.role === 'builder');
      const res = this.hooks.issue({ c: 'construct', key: this.placeKey, tx, ty, builders: this.ids(builders) });
      if (res) {
        this.hooks.toast(res, 'error');
        sfx('error');
        return;
      }
      sfx('done');
      this.marker(tx + def.w / 2, ty + def.h / 2, 'build');
      this.mode = 'normal';
      this.placeKey = null;
      return;
    }
    if (this.mode === 'target') {
      const res = this.hooks.issue({ c: 'super', x, y });
      if (res) {
        this.hooks.toast(res, 'error');
        sfx('error');
      } else this.marker(x, y, 'attack');
      this.mode = 'normal';
      return;
    }
    if (this.mode === 'rally' && this.building) {
      this.hooks.issue({ c: 'rally', b: this.building.id, x, y });
      this.marker(x, y, 'rally');
      sfx('move');
      this.openBuildingRadial(this.building);
    }
  }

  superweapon(): void {
    const sw = this.w.superweapon(this.me);
    if (!sw) {
      this.hooks.toast('You have no superweapon (HQ Tier 4)', 'error');
      return;
    }
    if (sw.charge > 0) {
      this.hooks.toast(`${sw.def.name} charging: ${Math.ceil(sw.charge)}s`, 'error');
      return;
    }
    this.closeRadial();
    this.mode = 'target';
    this.hooks.toast('Choose a target (A / tap to fire, B to cancel)', 'warn');
    sfx('warn');
  }

  toggleZoom(): void {
    const cam = this.r.cam;
    if (this.zoomBack) {
      cam.zoom = this.zoomBack;
      this.zoomBack = 0;
    } else {
      this.zoomBack = cam.zoom;
      cam.zoom = 17;
    }
  }

  jumpTo(x: number, y: number): void {
    this.r.cam.x = x;
    this.r.cam.y = y;
    // put the reticle back in the middle, on whatever we jumped to
    if (this.padCursor) {
      this.padCursor.x = this.r.w / 2;
      this.padCursor.y = this.r.h / 2;
    }
  }

  jumpHQ(): void {
    const hq = this.w.players[this.me].hq;
    if (!hq || hq.dead) return;
    this.jumpTo(hq.x, hq.y + 1);
    this.selectBuilding(hq);
  }

  jumpArmy(): void {
    const army = this.w.units.filter((u) => u.owner === this.me && !u.dead && !u.container && this.isArmy(u));
    if (!army.length) {
      this.hooks.toast('You have no army');
      return;
    }
    const cx = army.reduce((s, u) => s + u.x, 0) / army.length;
    const cy = army.reduce((s, u) => s + u.y, 0) / army.length;
    // jump to the unit nearest the centre of mass (so we don't land in empty space)
    const c = army.sort((a, b) => dist(a.x, a.y, cx, cy) - dist(b.x, b.y, cx, cy))[0];
    this.jumpTo(c.x, c.y);
    this.setSelection(army);
  }

  jumpAlert(): void {
    const alerts = this.hooks.alerts().filter((a) => a.kind === 'attack' || a.kind === 'warn');
    const a = alerts[alerts.length - 1];
    if (!a) {
      this.hooks.toast('No recent alerts');
      return;
    }
    this.jumpTo(a.x, a.y);
  }

  nextProduction(): void {
    const list = this.w.buildings.filter((b) => b.owner === this.me && !b.dead && b.built && (b.def.produces || b.def.research));
    if (!list.length) return;
    this.prodIdx = (this.prodIdx + 1) % list.length;
    const b = list[this.prodIdx];
    this.jumpTo(b.x, b.y + 1);
    this.selectBuilding(b);
  }

  private cancelQueue(): void {
    if (!this.building) return;
    const res = this.hooks.issue({ c: 'cancel', b: this.building.id });
    if (res) this.hooks.toast(res, 'error');
    else sfx('click');
  }

  // ---------------------------------------------------------------- radial menus

  closeRadial(): void {
    if (this.mode === 'radial') this.mode = 'normal';
    this.radial = null;
    this.building = null;
  }

  private back(): void {
    const b = this.radial?.back;
    if (b) b();
    else this.closeRadial();
  }

  private choose(i: number): void {
    if (!this.radial) return;
    const opts = this.radial.options();
    const o = opts[i];
    if (!o) return;
    this.radial.index = i;
    if (!o.enabled) {
      this.hooks.toast(o.reason || 'Unavailable', 'error');
      sfx('error');
      return;
    }
    o.run();
  }

  /** Public so the HUD can forward taps/clicks on radial options. */
  chooseOption(i: number): void {
    this.choose(i);
  }

  openBuildingRadial(b: Building): void {
    this.building = b;
    this.mode = 'radial';
    const w = this.w;
    const me = this.me;
    const pl = () => w.players[me];
    this.radial = {
      title: b.def.name,
      subtitle: b.built ? b.def.desc : 'Under construction',
      index: this.radial?.title === b.def.name ? this.radial.index : 0,
      options: () => {
        const out: RadialOption[] = [];
        if (!b.built) {
          out.push({
            id: 'cancel-build', icon: '✕', label: 'Cancel construction', detail: 'Full refund', enabled: true,
            run: () => {
              this.hooks.issue({ c: 'cancelConstruct', b: b.id });
              this.closeRadial();
            },
          });
          return out;
        }
        for (const k of b.def.produces ?? []) {
          const d = unitDef(pl().faction, k);
          const why = w.unitBlocker(b, k);
          const queued = b.queue.filter((q) => q.key === k).length;
          const head = b.queue[0]?.key === k ? b.queue[0].t / b.queue[0].total : undefined;
          out.push({
            id: k, icon: d.icon, label: d.name, detail: d.desc, cost: d.cost, enabled: !why, reason: why, count: queued, progress: head,
            run: () => {
              const res = this.hooks.issue({ c: 'queue', b: b.id, key: k });
              if (res) {
                this.hooks.toast(res, 'error');
                sfx('error');
              } else sfx('click');
            },
          });
        }
        // upgrades: inline when there's room, otherwise in their own sub-menu
        const research = this.researchOptions(b);
        if (research.length && out.length + research.length > 5) {
          const done = (b.def.research ?? []).filter((k) => pl().researched.has(k)).length;
          out.push({
            id: 'upgrades', icon: '⬆', label: 'Upgrades ▸', detail: `Unit upgrades researched here (${done} of ${(b.def.research ?? []).length} done).`, enabled: true,
            count: b.queue.filter((q) => q.kind === 'research').length,
            run: () => {
              const parent = this.radial;
              this.radial = {
                title: `${b.def.name} upgrades`,
                subtitle: '',
                index: 0,
                options: () => this.researchOptions(b),
                back: () => {
                  this.radial = parent;
                },
              };
            },
          });
        } else out.push(...research);
        if (b.def.produces) {
          out.push({
            id: 'rally', icon: '⚑', label: 'Set rally point', detail: 'New units will head here. (Or press X anywhere while this building is selected.)', enabled: true,
            run: () => {
              this.mode = 'rally';
              this.radial = null;
              this.hooks.toast('Choose the rally point (A / tap)', 'info');
            },
          });
        }
        if (b.queue.length) {
          out.push({ id: 'cancelq', icon: '↶', label: 'Cancel last', detail: 'Remove the last item from the queue (refunded).', enabled: true, run: () => this.cancelQueue() });
        }
        if (b.def.garrison) {
          out.push({
            id: 'eject', icon: '⇪', label: b.garrison ? 'Eject squad' : 'Empty', detail: b.garrison ? `${b.garrison.def.name} inside` : 'Select an infantry squad and press X on this to man it.',
            enabled: !!b.garrison, reason: 'Nobody inside',
            run: () => this.hooks.issue({ c: 'eject', b: b.id }),
          });
        }
        if (b.def.superweapon) {
          out.push({
            id: 'fire', icon: '☢', label: b.charge > 0 ? `Charging ${Math.ceil(b.charge)}s` : 'FIRE', detail: 'Launch the superweapon (also RT).', enabled: b.charge <= 0, reason: 'Still charging',
            run: () => this.superweapon(),
          });
        }
        return out;
      },
    };
  }

  private researchOptions(b: Building): RadialOption[] {
    const w = this.w;
    const pl = w.players[this.me];
    const fac = FACTIONS[pl.faction];
    const out: RadialOption[] = [];
    for (const k of b.def.research ?? []) {
      const d = fac.research[k]!;
      if (pl.researched.has(k)) continue;
      if (d.tier && d.tier !== pl.tier + 1) continue;
      const why = w.researchBlocker(b, k);
      const inQ = b.queue.find((q) => q.key === k);
      out.push({
        id: k, icon: d.icon, label: d.name, detail: d.desc, cost: d.cost, enabled: !why, reason: why, count: inQ ? 1 : 0,
        progress: inQ && b.queue[0] === inQ ? inQ.t / inQ.total : undefined,
        run: () => {
          const res = this.hooks.issue({ c: 'research', b: b.id, key: k });
          if (res) {
            this.hooks.toast(res, 'error');
            sfx('error');
          } else sfx('click');
        },
      });
    }
    return out;
  }

  openBuildMenu(): void {
    const builders = this.selected.filter((u) => u.def.role === 'builder');
    if (!builders.length) {
      this.hooks.toast('Select a builder to construct', 'error');
      return;
    }
    const w = this.w;
    const me = this.me;
    const fac = FACTIONS[w.players[me].faction];
    const option = (k: BuildingKey): RadialOption => {
      const d = fac.buildings[k]!;
      const req = w.requirement(me, k);
      const poor = w.players[me].supplies < d.cost ? 'Not enough supplies' : '';
      return {
        id: k, icon: d.icon, label: d.name, detail: d.desc, cost: d.cost, enabled: !req && !poor, reason: req || poor,
        run: () => {
          this.radial = null;
          this.mode = 'place';
          this.placeKey = k;
          this.hooks.toast(`Place the ${d.name} (A / tap to build, B to cancel)`, 'info');
        },
      };
    };
    this.building = null;
    this.mode = 'radial';
    const main: Radial = {
      title: 'Construct',
      subtitle: `${builders.length} builder${builders.length > 1 ? 's' : ''} selected`,
      index: 0,
      options: () => [
        ...fac.buildMenu.map(option),
        {
          id: 'defenses', icon: '▣', label: 'Defences ▸', detail: 'Gunner emplacements, anti-air and artillery.', enabled: true,
          run: () => {
            this.radial = {
              title: 'Defences',
              subtitle: 'Requires the ' + fac.buildings.defense!.name,
              index: 0,
              options: () => fac.defenseMenu.map(option),
              back: () => {
                this.radial = main;
              },
            };
          },
        },
      ],
    };
    this.radial = main;
  }
}

export type { Pile };
