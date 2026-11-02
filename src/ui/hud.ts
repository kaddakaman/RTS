// The in-game heads-up display (DOM): resources, alerts, selection info,
// radial menus, minimap, touch buttons and controller hints.

import { ABILITIES, ARMOR_NAMES, FACTIONS, TEAM_COLORS } from '../data/defs';
import type { Alert, Unit } from '../sim/entities';
import type { World } from '../sim/world';
import type { Input } from '../input/input';
import type { Renderer } from '../render/renderer';
import type { Controller, RadialOption } from './controller';
import { el, fmtTime } from './dom';

export class Hud {
  root: HTMLElement;
  private top: HTMLElement;
  private topStats: HTMLElement;
  private toasts: HTMLElement;
  private sel: HTMLElement;
  private info: HTMLElement;
  private radialEl: HTMLElement;
  private mini: HTMLCanvasElement;
  private miniCtx: CanvasRenderingContext2D;
  private touch: HTMLElement;
  private hints: HTMLElement;
  private miniT = 0;
  private fogCanvas: HTMLCanvasElement | null = null;
  private fogImg: ImageData | null = null;
  private selT = 0;
  private radialSig = '';
  private seenAlerts = 0;
  private topHtml = '';
  onPause: () => void = () => {};
  showTouch: () => boolean = () => this.input.device === 'touch';
  onAlert: (a: Alert) => void = () => {};

  constructor(
    parent: HTMLElement,
    private getWorld: () => World,
    private me: () => number,
    private ctl: Controller,
    private r: Renderer,
    private input: Input,
  ) {
    this.root = el('div', { class: 'hud' });
    parent.appendChild(this.root);
    this.top = el('div', { class: 'hud-top' });
    this.topStats = el('div', { class: 'stats' });
    const pause = el('button', { class: 'pausebtn', 'aria-label': 'Pause' }, '☰');
    pause.addEventListener('click', () => this.onPause());
    this.top.append(this.topStats, pause);
    this.toasts = el('div', { class: 'toasts' });
    this.sel = el('div', { class: 'selpanel' });
    this.info = el('div', { class: 'hoverinfo hidden' });
    this.radialEl = el('div', { class: 'radial hidden' });
    this.mini = el('canvas', { class: 'minimap' }) as HTMLCanvasElement;
    this.mini.width = 192;
    this.mini.height = 192;
    this.miniCtx = this.mini.getContext('2d')!;
    this.touch = el('div', { class: 'touchpad' });
    this.hints = el('div', { class: 'padhints' });
    this.root.append(this.top, this.toasts, this.info, this.sel, this.mini, this.touch, this.hints, this.radialEl);
    this.mini.addEventListener('pointerdown', (e) => this.miniJump(e));
    this.mini.addEventListener('pointermove', (e) => {
      if (e.buttons) this.miniJump(e);
    });
    this.buildTouch();
  }

  private get w(): World {
    return this.getWorld();
  }

  toast(text: string, kind: 'info' | 'error' | 'done' | 'warn' | 'attack' = 'info'): void {
    const t = el('div', { class: `toast ${kind}` }, text);
    this.toasts.prepend(t);
    while (this.toasts.children.length > 4) this.toasts.lastChild?.remove();
    setTimeout(() => t.classList.add('fade'), 3200);
    setTimeout(() => t.remove(), 4000);
  }

  update(dt: number): void {
    const w = this.w;
    const me = this.me();
    const pl = w.players[me];
    // new alerts for this player
    for (const a of w.alerts) {
      if (a.seq <= this.seenAlerts) continue;
      this.seenAlerts = a.seq;
      if (a.owner !== me) continue;
      this.toast(a.text, a.kind);
      this.onAlert(a);
    }

    // top bar
    const sw = w.superweapon(me);
    const income = Math.round(w.incomeRate(me) / 10) * 10;
    const tierNames = ['', 'I', 'II', 'III', 'IV'];
    const popCls = pl.pop >= pl.popCap ? 'warn' : '';
    const html =
      `<span class="res" title="Supplies">⬢ <b>${Math.floor(pl.supplies).toLocaleString()}</b> <small>+${income}/min</small></span>` +
      `<span class="pop ${popCls}" title="Units / cap">▲ <b>${pl.pop}</b>/${pl.popCap}</span>` +
      `<span class="tier" title="HQ tier">Tier <b>${tierNames[pl.tier]}</b></span>` +
      (sw ? `<span class="super ${sw.charge <= 0 ? 'ready' : ''}">☢ ${sw.charge <= 0 ? 'READY' : fmtTime(sw.charge)}</span>` : '') +
      `<span class="clock">${fmtTime(w.time)}</span>`;
    if (html !== this.topHtml) {
      this.topHtml = html;
      this.topStats.innerHTML = html;
    }

    // selection panel (a few times a second is plenty)
    this.selT -= dt;
    if (this.selT <= 0) {
      this.selT = 0.15;
      this.renderSelection();
      this.renderHover();
      this.renderTouch();
      this.renderHints();
    }
    this.renderRadial();

    this.miniT -= dt;
    if (this.miniT <= 0) {
      this.miniT = 0.15;
      this.drawMinimap();
    }
  }

  // ---------------------------------------------------------------- selection info

  private renderSelection(): void {
    const ctl = this.ctl;
    const w = this.w;
    const b = ctl.building;
    if (ctl.mode === 'radial' && ctl.radial) {
      this.sel.classList.add('hidden');
      return;
    }
    if (b && !b.dead) {
      const q = b.queue
        .map((it, i) => {
          const d = it.kind === 'unit' ? FACTIONS[b.faction].units[it.key as keyof typeof FACTIONS.coalition.units] : FACTIONS[b.faction].research[it.key as 'tier2'];
          const pct = i === 0 ? Math.round((it.t / it.total) * 100) : 0;
          return `<span class="qitem">${d?.icon ?? '?'}${i === 0 ? `<i style="width:${pct}%"></i>` : ''}</span>`;
        })
        .join('');
      this.sel.innerHTML = `<div class="selname">${b.def.name}</div><div class="hpline">${hpBar(b.hp / b.maxHp)} ${Math.ceil(b.hp)}/${b.maxHp}</div>${q ? `<div class="queue">${q}</div>` : ''}`;
      this.sel.classList.remove('hidden');
      return;
    }
    const sel = ctl.selected;
    if (!sel.length) {
      this.sel.classList.add('hidden');
      return;
    }
    this.sel.classList.remove('hidden');
    if (sel.length === 1) {
      const u = sel[0];
      this.sel.innerHTML = unitCard(u, true);
      return;
    }
    const groups = new Map<string, Unit[]>();
    for (const u of sel) {
      const g = groups.get(u.key) ?? [];
      g.push(u);
      groups.set(u.key, g);
    }
    let html = `<div class="selname">${sel.length} units</div><div class="groups">`;
    for (const [, us] of groups) {
      const hp = us.reduce((s, u) => s + u.hp / u.maxHp, 0) / us.length;
      html += `<span class="grp" title="${us[0].def.name}"><b>${us[0].def.icon}</b>×${us.length}${hpBar(hp)}</span>`;
    }
    html += '</div>';
    const ab = sel.find((u) => u.def.ability && u.def.ability !== 'build');
    if (ab) {
      const a = ABILITIES[ab.def.ability!];
      const cd = Math.max(0, ...sel.filter((u) => u.def.ability === ab.def.ability).map((u) => u.abilityCd));
      html += `<div class="ability">Y: ${a.name}${cd > 0 ? ` (${Math.ceil(cd)}s)` : ''}</div>`;
    } else if (sel.some((u) => u.def.role === 'builder')) html += `<div class="ability">Y: Build menu</div>`;
    void w;
    this.sel.innerHTML = html;
  }

  private renderHover(): void {
    const h = this.ctl.hover;
    const me = this.me();
    if (!h || (h.kind !== 'pile' && h.owner === me && this.ctl.selected.includes(h as Unit))) {
      this.info.classList.add('hidden');
      return;
    }
    let html = '';
    if (h.kind === 'pile') html = `<b>${h.label}</b><br>⬢ ${Math.round(h.amount).toLocaleString()} supplies left`;
    else {
      const owner = this.w.players[h.owner];
      const col = TEAM_COLORS[h.owner] ?? '#aaa';
      const tag = h.owner === me ? 'Yours' : this.w.hostile(me, h.owner) ? (h.owner === 4 ? 'Marauders' : `Enemy (${owner.name})`) : `Ally (${owner.name})`;
      if (h.kind === 'unit') html = `<span style="color:${col}">● ${tag}</span><br>${unitCard(h, false)}`;
      else html = `<span style="color:${col}">● ${tag}</span><br><b>${h.def.name}</b> ${hpBar(h.hp / h.maxHp)}${h.built ? '' : ' (building)'}`;
    }
    this.info.innerHTML = html;
    this.info.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- radial menu

  private renderRadial(): void {
    const ctl = this.ctl;
    const rad = ctl.mode === 'radial' ? ctl.radial : null;
    if (!rad) {
      if (!this.radialEl.classList.contains('hidden')) {
        this.radialEl.classList.add('hidden');
        this.radialEl.innerHTML = '';
        this.radialSig = '';
      }
      return;
    }
    const opts = rad.options();
    const pl = this.w.players[this.me()];
    const sig = rad.title + '|' + rad.index + '|' + Math.floor(pl.supplies / 25) + '|' + opts.map((o) => `${o.id}${o.enabled ? 1 : 0}${o.count ?? 0}${o.progress !== undefined ? Math.round(o.progress * 20) : ''}${o.label}`).join(',');
    if (sig === this.radialSig) return;
    this.radialSig = sig;
    this.radialEl.classList.remove('hidden');
    this.radialEl.innerHTML = '';
    const n = opts.length;
    const R = Math.min(150, Math.min(window.innerHeight, window.innerWidth) * 0.32);
    const ring = el('div', { class: 'ring' });
    ring.style.width = ring.style.height = `${R * 2 + 90}px`;
    opts.forEach((o, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const btn = el('button', { class: `opt ${o.enabled ? '' : 'disabled'} ${i === rad.index ? 'focus' : ''}` });
      btn.style.left = `calc(50% + ${Math.cos(a) * R}px)`;
      btn.style.top = `calc(50% + ${Math.sin(a) * R}px)`;
      btn.innerHTML = `<span class="ic">${o.icon}</span><span class="lb">${o.label}</span>${o.cost ? `<span class="cost">⬢${o.cost}</span>` : ''}${o.count ? `<span class="cnt">${o.count}</span>` : ''}${o.progress !== undefined ? `<span class="prog"><i style="width:${Math.round(o.progress * 100)}%"></i></span>` : ''}`;
      btn.addEventListener('pointerenter', () => {
        if (this.input.device === 'mouse') rad.index = i;
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        ctl.chooseOption(i);
      });
      ring.appendChild(btn);
    });
    const cur = opts[rad.index];
    const center = el('div', { class: 'center' });
    center.innerHTML = `<div class="title">${rad.title}</div>${cur ? optDetail(cur) : `<div class="sub">${rad.subtitle}</div>`}`;
    ring.appendChild(center);
    const close = el('button', { class: 'closebtn' }, '✕');
    close.addEventListener('click', () => this.ctl.cancel());
    this.radialEl.append(ring, close);
    this.radialEl.onclick = (e) => {
      if (e.target === this.radialEl) this.ctl.cancel();
    };
  }

  // ---------------------------------------------------------------- touch controls

  private touchBtns: Record<string, HTMLButtonElement> = {};

  private buildTouch(): void {
    const mk = (id: string, label: string, fn: () => void, cls = '') => {
      const b = el('button', { class: `tbtn ${cls}` }, label) as HTMLButtonElement;
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        fn();
      });
      this.touchBtns[id] = b;
      this.touch.appendChild(b);
    };
    const c = this.ctl;
    mk('ability', 'Ability', () => c.ability(), 'big');
    mk('army', 'Army', () => c.selectArmy(false));
    mk('all', 'All', () => c.selectArmy(true));
    mk('type', 'Type', () => c.cycleSubgroup());
    mk('cancel', '✕', () => c.cancel());
    mk('base', 'Base', () => c.jumpHQ());
    mk('alert', 'Alert', () => c.jumpAlert());
    mk('zoom', 'Zoom', () => c.toggleZoom());
    mk('power', '☢ Fire', () => c.superweapon(), 'power');
  }

  private renderTouch(): void {
    const show = this.showTouch();
    this.touch.classList.toggle('hidden', !show);
    if (!show) return;
    const c = this.ctl;
    const sel = c.selected;
    const ab = this.touchBtns.ability;
    if (sel.some((u) => u.def.role === 'builder')) ab.textContent = 'Build';
    else {
      const u = sel.find((x) => x.def.ability);
      ab.textContent = u ? ABILITIES[u.def.ability!].name : c.building?.garrison ? 'Eject' : 'Ability';
    }
    const sw = this.w.superweapon(this.me());
    this.touchBtns.power.classList.toggle('hidden', !sw || sw.charge > 0);
    this.touchBtns.type.classList.toggle('hidden', new Set(sel.map((u) => u.key)).size < 2);
  }

  private renderHints(): void {
    const gp = this.input.device === 'gamepad';
    this.hints.classList.toggle('hidden', !gp);
    if (!gp) return;
    const c = this.ctl;
    let h = '';
    if (c.mode === 'radial') h = '<b>L-stick</b> choose · <b>A</b> confirm · <b>X</b> cancel last · <b>B</b> back';
    else if (c.mode === 'place') h = '<b>A</b> build here · <b>B</b> cancel';
    else if (c.mode === 'target') h = '<b>A</b> FIRE · <b>B</b> cancel';
    else if (c.mode === 'rally') h = '<b>A</b> set rally point · <b>B</b> cancel';
    else if (c.selected.length) h = '<b>X</b> command · <b>Y</b> ability · <b>RB</b> unit type · <b>B</b> deselect · <b>LB</b> army';
    else h = '<b>A</b> select (hold: paint) · <b>LB</b> army (×2 all) · <b>D-pad</b> ▲base ▼army ◀alert ▶buildings · <b>LT</b> zoom';
    this.hints.innerHTML = h;
  }

  // ---------------------------------------------------------------- minimap

  private miniJump(e: PointerEvent): void {
    e.stopPropagation();
    const rect = this.mini.getBoundingClientRect();
    const m = this.w.map;
    const x = ((e.clientX - rect.left) / rect.width) * m.w;
    const y = ((e.clientY - rect.top) / rect.height) * m.h;
    this.ctl.jumpTo(x, y);
  }

  private drawMinimap(): void {
    const ctx = this.miniCtx;
    const w = this.w;
    const m = w.map;
    const S = this.mini.width / m.w;
    const me = this.me();
    const pl = w.players[me];
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.r.minimapBase, 0, 0, this.mini.width, this.mini.height);
    // fog (one pixel per tile, scaled up)
    if (!w.reveal) {
      if (!this.fogCanvas || this.fogCanvas.width !== m.w) {
        this.fogCanvas = document.createElement('canvas');
        this.fogCanvas.width = m.w;
        this.fogCanvas.height = m.h;
        this.fogImg = this.fogCanvas.getContext('2d')!.createImageData(m.w, m.h);
      }
      const d = this.fogImg!.data;
      for (let i = 0; i < pl.vis.length; i++) {
        const j = i * 4;
        d[j] = 6;
        d[j + 1] = 8;
        d[j + 2] = 14;
        d[j + 3] = pl.vis[i] ? 0 : pl.explored[i] ? 115 : 242;
      }
      this.fogCanvas.getContext('2d')!.putImageData(this.fogImg!, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.fogCanvas, 0, 0, this.mini.width, this.mini.height);
    }
    for (const c of w.camps) {
      if (!c.zone.active) continue;
      ctx.strokeStyle = 'rgba(255,140,50,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(c.zone.cx * S, c.zone.cy * S, c.zone.r * S, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const p of w.piles) {
      if (p.amount <= 0 || !w.tileExplored(me, p.x, p.y)) continue;
      ctx.fillStyle = '#ffd34a';
      ctx.fillRect(p.tx * S, p.ty * S, 2 * S, 2 * S);
    }
    for (const g of pl.ghosts.values()) {
      ctx.fillStyle = TEAM_COLORS[g.owner] ?? '#aaa';
      ctx.globalAlpha = 0.6;
      ctx.fillRect(g.tx * S, g.ty * S, g.w * S, g.h * S);
      ctx.globalAlpha = 1;
    }
    for (const b of w.buildings) {
      if (b.dead || (!w.visibleTo(b, me) && b.owner !== me)) continue;
      ctx.fillStyle = TEAM_COLORS[b.owner] ?? '#aaa';
      ctx.fillRect(b.tx * S, b.ty * S, b.w * S, b.h * S);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeRect(b.tx * S + 0.5, b.ty * S + 0.5, b.w * S - 1, b.h * S - 1);
    }
    for (const u of w.units) {
      if (u.dead || u.container || !w.visibleTo(u, me)) continue;
      ctx.fillStyle = TEAM_COLORS[u.owner] ?? '#aaa';
      const s = u.air ? 3 : 2.5;
      ctx.fillRect(u.x * S - s / 2, u.y * S - s / 2, s, s);
    }
    // recent attack alerts ping
    const now = w.time;
    for (const a of w.alerts) {
      if (a.owner !== me || a.kind !== 'attack' || now - a.t > 4) continue;
      const k = (now - a.t) % 1;
      ctx.strokeStyle = `rgba(255,70,50,${1 - k})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(a.x * S, a.y * S, 4 + k * 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    // camera view
    const tl = this.r.screenToWorld(0, 0);
    const br = this.r.screenToWorld(this.r.w, this.r.h);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tl.x * S, tl.y * S, (br.x - tl.x) * S, (br.y - tl.y) * S);
  }
}

// ---------------------------------------------------------------- helpers

function hpBar(f: number): string {
  const c = f > 0.6 ? '#5bea5b' : f > 0.3 ? '#f2d03b' : '#f2533b';
  return `<span class="hp"><i style="width:${Math.round(Math.max(0, f) * 100)}%;background:${c}"></i></span>`;
}

function unitCard(u: Unit, full: boolean): string {
  const d = u.def;
  const members = d.members ? ` · ${u.alive}/${u.members} ${u.medic ? '(+medic)' : ''}` : '';
  const weapons = d.weapons.map((w) => w.name).join(', ');
  let html = `<div class="selname">${d.name}</div><div class="hpline">${hpBar(u.hp / u.maxHp)} ${Math.ceil(u.hp)}/${Math.round(u.maxHp)}${members}</div>`;
  html += `<div class="rps"><span class="good">Strong vs: ${d.strong}</span><span class="bad">Weak vs: ${d.weak}</span></div>`;
  if (full) {
    html += `<div class="sub">${ARMOR_NAMES[d.armor]}${weapons ? ' · ' + weapons : ' · unarmed'}</div>`;
    if (d.capacity) html += `<div class="sub">Carrying ${u.passengers.length}/${d.capacity}</div>`;
    if (d.carry) html += `<div class="sub">Cargo ${Math.round(u.cargo)}/${d.carry}</div>`;
    if (d.bomber) html += `<div class="sub">${u.ammo > 0 ? 'Armed' : 'Rearming at air base'}</div>`;
    if (d.ability) {
      const a = ABILITIES[d.ability];
      html += `<div class="ability">Y: ${a.name}${u.abilityCd > 0 ? ` (${Math.ceil(u.abilityCd)}s)` : ''}</div>`;
    }
  }
  return html;
}

function optDetail(o: RadialOption): string {
  return `<div class="oname">${o.label}</div>${o.cost ? `<div class="ocost">⬢ ${o.cost}</div>` : ''}<div class="odesc">${o.detail}</div>${!o.enabled && o.reason ? `<div class="oreason">${o.reason}</div>` : ''}`;
}
