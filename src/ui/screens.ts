// Menus: title, skirmish setup, online lobby, how to play, settings, pause
// and the end-of-match screen. Every menu can be driven by gamepad (D-pad /
// stick to move, A to press, left/right to change a setting, B to go back),
// touch or mouse.

import { sfx } from '../core/audio';
import { FACTIONS, PLAYABLE, SLOT_NAMES, TEAM_COLORS, type FactionId, type UnitKey } from '../data/defs';
import { BTN, type Input } from '../input/input';
import type { LobbySlot, LobbyState } from '../net/protocol';
import type { World } from '../sim/world';
import { button, el, fmtTime } from './dom';

export interface Settings {
  sound: boolean;
  quality: 'high' | 'saver';
  touch: 'auto' | 'on' | 'off';
  name: string;
}

export interface MenuActions {
  startSkirmish(lobby: LobbyState): void;
  hostOnline(): Promise<string>;
  joinOnline(code: string): Promise<void>;
  startOnline(): void;
  setLobby(lobby: LobbyState): void;
  pickFaction(f: 'coalition' | 'sythari'): void;
  leaveOnline(): void;
  resume(): void;
  surrender(): void;
  quit(): void;
  saveSettings(s: Settings): void;
}

type ScreenId = 'title' | 'skirmish' | 'online' | 'hostLobby' | 'guestLobby' | 'help' | 'settings' | 'pause' | 'end' | 'stats' | 'loading';

export class Screens {
  root: HTMLElement;
  current: ScreenId | null = null;
  private focusIdx = 0;
  private backFn: (() => void) | null = null;
  private stickT = 0;
  lobby: LobbyState = defaultLobby('local');
  roomCode = '';
  guestSlot = -1;
  private helpTab = 0;

  constructor(
    parent: HTMLElement,
    private input: Input,
    private act: MenuActions,
    public settings: Settings,
  ) {
    this.root = el('div', { class: 'screens hidden' });
    parent.appendChild(this.root);
  }

  get open(): boolean {
    return this.current !== null;
  }

  close(): void {
    this.current = null;
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
  }

  private show(id: ScreenId, panel: HTMLElement, back: (() => void) | null, cls = ''): void {
    this.current = id;
    this.backFn = back;
    this.root.className = `screens ${cls}`;
    this.root.innerHTML = '';
    this.root.appendChild(panel);
    this.focusIdx = 0;
    this.input.consume();
    this.highlight();
  }

  // ---------------------------------------------------------------- gamepad navigation

  update(dt: number): void {
    if (!this.current) return;
    const inp = this.input;
    if (!inp.padConnected) return;
    const [lx, ly] = inp.axes;
    this.stickT -= dt;
    let dir: 'up' | 'down' | 'left' | 'right' | null = null;
    if (inp.pressed(BTN.UP)) dir = 'up';
    else if (inp.pressed(BTN.DOWN)) dir = 'down';
    else if (inp.pressed(BTN.LEFT)) dir = 'left';
    else if (inp.pressed(BTN.RIGHT)) dir = 'right';
    else if (this.stickT <= 0 && (Math.abs(lx) > 0.6 || Math.abs(ly) > 0.6)) {
      dir = Math.abs(ly) > Math.abs(lx) ? (ly < 0 ? 'up' : 'down') : lx < 0 ? 'left' : 'right';
      this.stickT = 0.22;
    }
    if (Math.abs(lx) < 0.3 && Math.abs(ly) < 0.3) this.stickT = 0;
    const items = this.items();
    const cur = items[this.focusIdx];
    if (dir) {
      if ((dir === 'left' || dir === 'right') && cur?.dataset.cycle) {
        cur.dispatchEvent(new CustomEvent('cycle', { detail: dir === 'left' ? -1 : 1 }));
        sfx('click');
      } else this.moveFocus(dir);
    }
    if (inp.pressed(BTN.A) && cur) {
      sfx('click');
      if (cur.tagName === 'INPUT') (cur as HTMLInputElement).focus();
      else cur.click();
    }
    if (inp.pressed(BTN.B) || inp.pressed(BTN.START)) {
      if (this.backFn) {
        sfx('click');
        this.backFn();
      }
    }
    if (inp.pressed(BTN.LB) || inp.pressed(BTN.RB)) {
      const tabs = this.root.querySelectorAll<HTMLElement>('.tab');
      if (tabs.length) {
        this.helpTab = (this.helpTab + (inp.pressed(BTN.RB) ? 1 : tabs.length - 1)) % tabs.length;
        tabs[this.helpTab].click();
      }
    }
  }

  private items(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>('.focusable')].filter((e) => !(e as HTMLButtonElement).disabled && e.offsetParent !== null);
  }

  private moveFocus(dir: 'up' | 'down' | 'left' | 'right'): void {
    const items = this.items();
    if (!items.length) return;
    const cur = items[this.focusIdx] ?? items[0];
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best = -1;
    let bs = Infinity;
    items.forEach((it, i) => {
      if (it === cur) return;
      const b = it.getBoundingClientRect();
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      const dx = bx - ax;
      const dy = by - ay;
      const ok = dir === 'up' ? dy < -4 : dir === 'down' ? dy > 4 : dir === 'left' ? dx < -4 : dx > 4;
      if (!ok) return;
      const along = dir === 'up' || dir === 'down' ? Math.abs(dy) : Math.abs(dx);
      const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      const s = along + across * 2.5;
      if (s < bs) {
        bs = s;
        best = i;
      }
    });
    if (best >= 0) {
      this.focusIdx = best;
      sfx('click');
      this.highlight();
    }
  }

  private highlight(): void {
    const items = this.items();
    items.forEach((e, i) => e.classList.toggle('pad-focus', i === this.focusIdx && this.input.device === 'gamepad'));
    items[this.focusIdx]?.scrollIntoView?.({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- title

  title(): void {
    const p = el('div', { class: 'panel title-panel' });
    p.innerHTML = `<div class="logo">SHATTER<span>FRONT</span></div><div class="tagline">Coalition vs Sythari · Marauders in between</div>`;
    const col = el('div', { class: 'menu-col' });
    col.append(
      button('Skirmish', () => this.skirmish(), 'primary'),
      button('Play Online', () => this.online()),
      button('How to Play', () => this.help(() => this.title())),
      button('Settings', () => this.settingsScreen(() => this.title())),
    );
    p.appendChild(col);
    p.appendChild(el('div', { class: 'foot' }, 'Plays best with a controller · Touch and keyboard also supported'));
    this.show('title', p, null, 'menu-bg');
  }

  // ---------------------------------------------------------------- skirmish / lobby slots

  skirmish(): void {
    this.lobby = loadLobby() ?? defaultLobby('local');
    this.renderSlotsScreen('skirmish');
  }

  private renderSlotsScreen(mode: 'skirmish' | 'hostLobby' | 'guestLobby'): void {
    const lobby = this.lobby;
    const p = el('div', { class: 'panel lobby-panel' });
    const title = mode === 'skirmish' ? 'Skirmish' : mode === 'hostLobby' ? 'Online - Host' : 'Online Game';
    const head = el('div', { class: 'lobby-head' });
    head.appendChild(el('h2', {}, title));
    if (mode === 'skirmish' || mode === 'hostLobby') {
      const preset = (label: string, fn: (l: LobbyState) => void) =>
        head.appendChild(
          button(label, () => {
            fn(lobby);
            this.changed(mode);
          }, 'small'),
        );
      preset('1v1', (l) => applyPreset(l, '1v1', mode !== 'skirmish'));
      preset('2v2', (l) => applyPreset(l, '2v2', mode !== 'skirmish'));
      if (mode === 'hostLobby') preset('Co-op vs 2 AI', (l) => applyPreset(l, 'coop', true));
      preset('Free for all', (l) => applyPreset(l, 'ffa', mode !== 'skirmish'));
    }
    p.appendChild(head);
    if (mode === 'hostLobby') {
      const code = el('div', { class: 'roomcode' });
      code.innerHTML = `Room code <b>${this.roomCode}</b><small>Your friend chooses <i>Play Online → Join</i> and enters this code.</small>`;
      p.appendChild(code);
    }
    const table = el('div', { class: 'slots' });
    lobby.slots.forEach((s, i) => table.appendChild(this.slotRow(s, i, mode)));
    p.appendChild(table);

    const err = validate(lobby, mode !== 'skirmish');
    const row = el('div', { class: 'menu-row' });
    const outpost = cycler(`Central outpost: ${lobby.centerOutpost ? 'On' : 'Off'}`, () => {
      if (mode === 'guestLobby') return;
      lobby.centerOutpost = !lobby.centerOutpost;
      this.changed(mode);
    });
    if (mode === 'guestLobby') outpost.classList.add('readonly');
    row.appendChild(outpost);
    if (mode === 'guestLobby') {
      row.appendChild(el('div', { class: 'waiting' }, 'Waiting for the host to start…'));
      row.appendChild(button('Leave', () => this.act.leaveOnline()));
    } else {
      row.appendChild(el('div', { class: 'warnline' }, err));
      const start = button(mode === 'skirmish' ? 'Start Battle' : 'Start Online Battle', () => {
        if (mode === 'skirmish') {
          saveLobby(lobby);
          this.act.startSkirmish(lobby);
        } else this.act.startOnline();
      }, 'primary');
      if (err) start.disabled = true;
      row.append(start, button('Back', () => (mode === 'skirmish' ? this.title() : this.act.leaveOnline())));
    }
    p.appendChild(row);
    p.appendChild(el('div', { class: 'note small' }, 'Bases nobody plays are taken over by the Marauders, who guard that base and its supplies. The central outpost guards the hoard in the middle.'));
    const keep = this.current === mode ? this.focusIdx : 0;
    this.show(mode, p, mode === 'skirmish' ? () => this.title() : () => this.act.leaveOnline(), 'menu-bg');
    this.focusIdx = keep;
    this.highlight();
  }

  private changed(mode: 'skirmish' | 'hostLobby' | 'guestLobby'): void {
    if (mode === 'hostLobby') this.act.setLobby(this.lobby);
    this.renderSlotsScreen(mode);
  }

  private slotRow(s: LobbySlot, i: number, mode: 'skirmish' | 'hostLobby' | 'guestLobby'): HTMLElement {
    const row = el('div', { class: `slotrow ${s.kind === 'marauder' ? 'empty' : ''}` });
    const sw = el('span', { class: 'swatch' });
    sw.style.background = TEAM_COLORS[i];
    row.append(sw, el('span', { class: 'slotname' }, SLOT_NAMES[i]));
    const editable = mode !== 'guestLobby';
    const isMe = (mode === 'guestLobby' && i === this.guestSlot) || (mode !== 'guestLobby' && (s.kind === 'host' || (mode === 'skirmish' && i === 0)));
    // who plays this base
    const kinds: LobbySlot['kind'][] = mode === 'skirmish' ? ['ai', 'marauder'] : ['open', 'ai', 'marauder'];
    const kindLabel = (sl: LobbySlot) =>
      sl.kind === 'host' ? (mode === 'skirmish' ? 'You' : `${sl.name} (host)`) : sl.kind === 'guest' ? sl.name : sl.kind === 'open' ? 'Open - online player' : sl.kind === 'ai' ? `AI (${sl.difficulty})` : 'Marauders (empty base)';
    const fixed = s.kind === 'host' || s.kind === 'guest' || !editable;
    const who = cycler(kindLabel(s), (d) => {
      if (fixed) return;
      // AI difficulties are part of the cycle
      const seq: string[] = [];
      for (const k of kinds) {
        if (k === 'ai') seq.push('ai:easy', 'ai:normal', 'ai:hard');
        else seq.push(k);
      }
      const curK = s.kind === 'ai' ? `ai:${s.difficulty}` : s.kind;
      const n = seq[(seq.indexOf(curK) + d + seq.length) % seq.length];
      if (n.startsWith('ai:')) {
        s.kind = 'ai';
        s.difficulty = n.slice(3) as LobbySlot['difficulty'];
        s.name = `AI`;
      } else {
        s.kind = n as LobbySlot['kind'];
        s.name = n === 'open' ? 'Open' : 'Marauders';
      }
      this.changed(mode);
    });
    if (fixed) who.classList.add('readonly');
    row.appendChild(who);
    if (s.kind !== 'marauder' && s.kind !== 'open') {
      const canFaction = editable ? s.kind !== 'guest' : isMe;
      const fac = cycler(FACTIONS[s.faction].short, () => {
        if (!canFaction) return;
        s.faction = s.faction === 'coalition' ? 'sythari' : 'coalition';
        if (mode === 'guestLobby') this.act.pickFaction(s.faction);
        this.changed(mode);
      });
      if (!canFaction) fac.classList.add('readonly');
      fac.classList.add(s.faction);
      row.appendChild(fac);
      const team = cycler(`Team ${s.team + 1}`, (d) => {
        if (!editable) return;
        s.team = (s.team + d + 4) % 4;
        this.changed(mode);
      });
      if (!editable) team.classList.add('readonly');
      row.appendChild(team);
    }
    if (isMe) row.classList.add('me');
    return row;
  }

  // ---------------------------------------------------------------- online

  online(): void {
    const p = el('div', { class: 'panel' });
    p.appendChild(el('h2', {}, 'Play Online'));
    p.appendChild(el('p', { class: 'note' }, 'Play against or alongside a friend on another phone. One of you hosts, the other joins with the room code. Both phones need an internet connection.'));
    const name = el('input', { class: 'focusable textin', maxlength: '16', value: this.settings.name, placeholder: 'Your name' }) as HTMLInputElement;
    name.addEventListener('change', () => {
      this.settings.name = name.value.trim().slice(0, 16) || 'Commander';
      this.act.saveSettings(this.settings);
    });
    const nl = el('label', { class: 'field' }, 'Your name ');
    nl.appendChild(name);
    p.appendChild(nl);
    const status = el('div', { class: 'status' });
    const col = el('div', { class: 'menu-col' });
    col.appendChild(
      button('Host a game', async () => {
        status.textContent = 'Opening a room…';
        try {
          const code = await this.act.hostOnline();
          this.roomCode = code;
        } catch (e) {
          status.textContent = (e as Error).message;
        }
      }, 'primary'),
    );
    const code = el('input', { class: 'focusable textin code', maxlength: '5', placeholder: 'CODE', autocapitalize: 'characters', autocomplete: 'off' }) as HTMLInputElement;
    const jl = el('div', { class: 'joinrow' });
    jl.appendChild(code);
    jl.appendChild(
      button('Join', async () => {
        const c = code.value.trim();
        if (c.length < 5) {
          status.textContent = 'Enter the 5-character room code from the host.';
          return;
        }
        status.textContent = 'Connecting…';
        try {
          await this.act.joinOnline(c);
        } catch (e) {
          status.textContent = (e as Error).message;
        }
      }),
    );
    col.appendChild(jl);
    col.appendChild(button('Back', () => this.title()));
    p.append(col, status);
    this.show('online', p, () => this.title(), 'menu-bg');
  }

  hostLobby(code: string): void {
    this.roomCode = code;
    this.lobby = defaultLobby('host', this.settings.name);
    this.renderSlotsScreen('hostLobby');
  }

  refreshHostLobby(lobby: LobbyState): void {
    this.lobby = lobby;
    if (this.current === 'hostLobby') this.renderSlotsScreen('hostLobby');
  }

  guestLobby(lobby: LobbyState, slot: number): void {
    this.lobby = lobby;
    this.guestSlot = slot;
    this.renderSlotsScreen('guestLobby');
  }

  message(title: string, text: string, then: () => void): void {
    const p = el('div', { class: 'panel' });
    p.append(el('h2', {}, title), el('p', {}, text));
    p.appendChild(button('OK', then, 'primary'));
    this.show('online', p, then, 'menu-bg');
  }

  loading(text: string): void {
    const p = el('div', { class: 'panel loading' });
    p.append(el('div', { class: 'spinner' }), el('p', {}, text));
    this.show('loading', p, null, 'menu-bg');
  }

  // ---------------------------------------------------------------- how to play

  help(back: () => void): void {
    const p = el('div', { class: 'panel help-panel' });
    p.appendChild(el('h2', {}, 'How to Play'));
    const tabs = el('div', { class: 'tabs' });
    const body = el('div', { class: 'helpbody' });
    const pages: [string, () => string][] = [
      ['Controller', helpGamepad],
      ['Touch', helpTouch],
      ['Keyboard', helpKeys],
      ['Counters', helpCounters],
      ['Basics', helpBasics],
    ];
    pages.forEach(([name, fn], i) => {
      const t = button(name, () => {
        this.helpTab = i;
        tabs.querySelectorAll('.tab').forEach((x, j) => x.classList.toggle('on', j === i));
        body.innerHTML = fn();
      }, 'tab small');
      tabs.appendChild(t);
    });
    p.append(tabs, body);
    p.appendChild(button('Back', back));
    this.show('help', p, back, 'menu-bg');
    (tabs.children[this.helpTab] as HTMLElement)?.click();
  }

  // ---------------------------------------------------------------- settings

  settingsScreen(back: () => void): void {
    const s = this.settings;
    const p = el('div', { class: 'panel' });
    p.appendChild(el('h2', {}, 'Settings'));
    const col = el('div', { class: 'menu-col' });
    const save = () => {
      this.act.saveSettings(s);
      this.settingsScreen(back);
    };
    col.appendChild(cycler(`Sound: ${s.sound ? 'On' : 'Off'}`, () => {
      s.sound = !s.sound;
      save();
    }));
    col.appendChild(cycler(`Graphics: ${s.quality === 'high' ? 'Sharp' : 'Battery saver'}`, () => {
      s.quality = s.quality === 'high' ? 'saver' : 'high';
      save();
    }));
    col.appendChild(cycler(`Touch buttons: ${s.touch === 'auto' ? 'Automatic' : s.touch === 'on' ? 'Always' : 'Never'}`, (d) => {
      const seq: Settings['touch'][] = ['auto', 'on', 'off'];
      s.touch = seq[(seq.indexOf(s.touch) + d + 3) % 3];
      save();
    }));
    col.appendChild(button('Back', back));
    p.appendChild(col);
    const keep = this.current === 'settings' ? this.focusIdx : 0;
    this.show('settings', p, back, 'menu-bg');
    this.focusIdx = keep;
    this.highlight();
  }

  // ---------------------------------------------------------------- in-game

  pause(online: boolean): void {
    const p = el('div', { class: 'panel' });
    p.appendChild(el('h2', {}, online ? 'Menu' : 'Paused'));
    if (online) p.appendChild(el('p', { class: 'note' }, 'Online game - the battle keeps going while this menu is open.'));
    const col = el('div', { class: 'menu-col' });
    col.append(
      button('Resume', () => this.act.resume(), 'primary'),
      button('How to Play', () => this.help(() => this.pause(online))),
      button('Settings', () => this.settingsScreen(() => this.pause(online))),
      button('Surrender', () => this.confirm('Surrender this battle?', () => this.act.surrender(), () => this.pause(online))),
      button('Quit to Menu', () => this.confirm('Leave this battle?', () => this.act.quit(), () => this.pause(online))),
    );
    p.appendChild(col);
    this.show('pause', p, () => this.act.resume(), 'dim');
  }

  private confirm(text: string, yes: () => void, no: () => void): void {
    const p = el('div', { class: 'panel' });
    p.appendChild(el('h2', {}, text));
    const row = el('div', { class: 'menu-row' });
    row.append(button('Yes', yes, 'danger'), button('No', no, 'primary'));
    p.appendChild(row);
    this.show('pause', p, no, 'dim');
    this.focusIdx = 1;
    this.highlight();
  }

  stats(w: World, me: number, back: () => void): void {
    const p = el('div', { class: 'panel stats-panel' });
    p.appendChild(el('h2', {}, `Battle report · ${fmtTime(w.time)}`));
    p.appendChild(statsTable(w, me));
    p.appendChild(button('Close', back, 'primary'));
    this.show('stats', p, back, 'dim');
  }

  end(w: World, me: number): void {
    const won = w.won(me);
    const p = el('div', { class: `panel end-panel ${won ? 'victory' : 'defeat'}` });
    p.appendChild(el('div', { class: 'endtitle' }, won ? 'VICTORY' : w.winnerTeam < 0 ? 'DRAW' : 'DEFEAT'));
    p.appendChild(el('div', { class: 'tagline' }, won ? 'The enemy HQ has fallen.' : 'Your HQ has been destroyed.'));
    p.appendChild(statsTable(w, me));
    p.appendChild(button('Main Menu', () => this.act.quit(), 'primary'));
    this.show('end', p, null, 'dim');
  }
}

// ---------------------------------------------------------------- widgets & helpers

/** A button that cycles a setting (A / tap = next, left/right on a gamepad = previous/next). */
function cycler(label: string, onCycle: (d: number) => void): HTMLButtonElement {
  const b = el('button', { class: 'btn focusable cycler', 'data-cycle': '1' }) as HTMLButtonElement;
  b.innerHTML = `<span class="arr">‹</span><span class="cv">${label}</span><span class="arr">›</span>`;
  b.addEventListener('click', (e) => {
    const r = b.getBoundingClientRect();
    const left = (e as MouseEvent).clientX > 0 && (e as MouseEvent).clientX < r.left + r.width * 0.25;
    onCycle(left ? -1 : 1);
  });
  b.addEventListener('cycle', (e) => onCycle((e as CustomEvent).detail));
  return b;
}

export function defaultLobby(mode: 'local' | 'host', name = 'You'): LobbyState {
  const s = (kind: LobbySlot['kind'], team: number, faction: 'coalition' | 'sythari' = 'coalition', nm = ''): LobbySlot => ({
    kind,
    name: nm || (kind === 'ai' ? 'AI' : kind === 'marauder' ? 'Marauders' : kind === 'open' ? 'Open' : name),
    faction,
    team,
    difficulty: 'normal',
  });
  return {
    slots: [s('host', 0, 'coalition', mode === 'local' ? 'You' : name), s('marauder', 1), mode === 'local' ? s('ai', 1, 'sythari') : s('open', 1, 'sythari'), s('marauder', 3)],
    centerOutpost: true,
  };
}

function applyPreset(l: LobbyState, p: '1v1' | '2v2' | 'coop' | 'ffa', online: boolean): void {
  const s = l.slots;
  const guest = s.find((x) => x.kind === 'guest');
  const setAI = (i: number, team: number, faction: 'coalition' | 'sythari') => {
    if (s[i].kind === 'host') return;
    if (guest && s[i] === guest) {
      s[i].team = team;
      return;
    }
    s[i] = { kind: 'ai', name: 'AI', faction, team, difficulty: s[i].difficulty ?? 'normal' };
  };
  const setOpen = (i: number, team: number) => {
    if (s[i].kind === 'host' || s[i].kind === 'guest') {
      s[i].team = team;
      return;
    }
    s[i] = { kind: 'open', name: 'Open', faction: 'sythari', team, difficulty: 'normal' };
  };
  const empty = (i: number) => {
    if (s[i].kind === 'host' || s[i].kind === 'guest') return;
    s[i] = { kind: 'marauder', name: 'Marauders', faction: 'coalition', team: i, difficulty: 'normal' };
  };
  s[0].team = 0;
  if (p === '1v1') {
    empty(1);
    if (online) setOpen(2, 1);
    else setAI(2, 1, 'sythari');
    empty(3);
  } else if (p === '2v2') {
    // you + AI ally vs (online: friend + AI) or 2 AI
    setAI(1, 0, 'coalition');
    if (online) setOpen(2, 1);
    else setAI(2, 1, 'sythari');
    setAI(3, 1, 'sythari');
  } else if (p === 'coop') {
    setOpen(1, 0);
    setAI(2, 1, 'sythari');
    setAI(3, 1, 'sythari');
  } else {
    if (online) setOpen(1, 1);
    else setAI(1, 1, 'sythari');
    setAI(2, 2, 'coalition');
    setAI(3, 3, 'sythari');
  }
}

/** Returns why the lobby can't start, or ''. */
function validate(l: LobbyState, online: boolean): string {
  const active = l.slots.filter((s) => s.kind === 'host' || s.kind === 'guest' || s.kind === 'ai' || (online && s.kind === 'open'));
  const teams = new Set(active.map((s) => s.team));
  if (active.length < 2) return 'Add at least one opponent.';
  if (teams.size < 2) return 'Everyone is on the same team - put someone on another team.';
  if (online && l.slots.some((s) => s.kind === 'open')) return 'Waiting for players to join (or change open slots to AI / Marauders).';
  return '';
}

function loadLobby(): LobbyState | null {
  try {
    const raw = localStorage.getItem('sf-lobby');
    if (!raw) return null;
    const l = JSON.parse(raw) as LobbyState;
    if (!Array.isArray(l.slots) || l.slots.length !== 4) return null;
    l.slots[0].kind = 'host';
    for (const s of l.slots) if (s.kind === 'open' || s.kind === 'guest') s.kind = 'ai';
    return l;
  } catch {
    return null;
  }
}

function saveLobby(l: LobbyState): void {
  try {
    localStorage.setItem('sf-lobby', JSON.stringify(l));
  } catch {
    /* storage unavailable */
  }
}

function statsTable(w: World, me: number): HTMLElement {
  const t = el('table', { class: 'stats' });
  t.innerHTML =
    '<tr><th></th><th>Units built</th><th>Units lost</th><th>Kills</th><th>Structures destroyed</th><th>Supplies gathered</th></tr>' +
    w.activePlayers
      .map(
        (p) =>
          `<tr class="${p.id === me ? 'me' : ''}"><td><span class="swatch" style="background:${TEAM_COLORS[p.id]}"></span>${p.name} <small>(${FACTIONS[p.faction].short}, team ${p.team + 1})${p.defeated ? ' ✝' : ''}</small></td><td>${p.stats.unitsBuilt}</td><td>${p.stats.unitsLost}</td><td>${p.stats.kills}</td><td>${p.stats.structuresDestroyed}</td><td>${Math.round(p.stats.gathered).toLocaleString()}</td></tr>`,
      )
      .join('');
  return t;
}

function helpGamepad(): string {
  return `<table class="keys">
<tr><td>Left stick</td><td>Move the reticle / camera</td></tr>
<tr><td>Right stick</td><td>Zoom (click to reset)</td></tr>
<tr><td>A</td><td>Select what's under the reticle. <b>Hold</b> to paint-select. Double-tap a unit: all of that type on screen.</td></tr>
<tr><td>X</td><td>Command: move, attack, gather, build/repair, board a transport or man an emplacement - whatever fits the target</td></tr>
<tr><td>Y</td><td>Special ability (grenade, recon pulse, boost, unload…). With builders selected: <b>build menu</b></td></tr>
<tr><td>B</td><td>Cancel / deselect / back</td></tr>
<tr><td>LB</td><td>Select all army on screen. Double-tap: your whole army</td></tr>
<tr><td>RB</td><td>Cycle through unit types in your selection</td></tr>
<tr><td>LT</td><td>Toggle the zoomed-out tactical view</td></tr>
<tr><td>RT</td><td>Fire your superweapon</td></tr>
<tr><td>D-pad</td><td>▲ HQ · ▼ army · ◀ latest alert · ▶ next production building</td></tr>
<tr><td>Start / Back</td><td>Pause menu / battle report</td></tr>
</table><p>Selecting a building opens its <b>radial menu</b>: point the stick at an option and press A to queue it. X cancels the last item. With a building selected, X on the ground sets its rally point.</p>`;
}

function helpTouch(): string {
  return `<table class="keys">
<tr><td>Drag</td><td>Scroll the map (two fingers: pinch to zoom)</td></tr>
<tr><td>Tap your unit</td><td>Select it. Double-tap: all of that type on screen</td></tr>
<tr><td>Long-press + drag</td><td>Paint-select several units</td></tr>
<tr><td>Tap the ground / enemy / cache</td><td>Order the selection: move, attack, gather…</td></tr>
<tr><td>Tap your building</td><td>Open its menu (or repair / man it if you have builders / infantry selected)</td></tr>
<tr><td>Buttons</td><td>Ability (or Build), Army, All, Type, ✕ cancel, Base, Alert, Zoom</td></tr>
<tr><td>Minimap</td><td>Tap to jump there</td></tr>
</table>`;
}

function helpKeys(): string {
  return `<table class="keys">
<tr><td>Left click / drag</td><td>Select / box select (Shift adds)</td></tr>
<tr><td>Right click</td><td>Command</td></tr>
<tr><td>WASD / arrows · wheel</td><td>Scroll · zoom</td></tr>
<tr><td>Q</td><td>Ability</td></tr><tr><td>B</td><td>Build menu</td></tr>
<tr><td>E (Shift+E)</td><td>Army on screen (whole army)</td></tr>
<tr><td>Tab</td><td>Cycle unit types</td></tr><tr><td>H / Space</td><td>HQ</td></tr>
<tr><td>G</td><td>Latest alert</td></tr><tr><td>P</td><td>Next production building</td></tr>
<tr><td>R</td><td>Superweapon</td></tr><tr><td>Z</td><td>Tactical zoom</td></tr><tr><td>Esc</td><td>Cancel / pause</td></tr>
</table>`;
}

function helpCounters(): string {
  const keys: UnitKey[] = ['rifle', 'sniper', 'rocket', 'scout', 'light', 'tank', 'apc', 'gunship', 'bomber', 'dropship'];
  let h = '<p>Every unit beats something and loses to something. Read the "Strong vs / Weak vs" line when you select a unit.</p><table class="counters"><tr><th>Role</th>';
  for (const f of PLAYABLE) h += `<th>${FACTIONS[f].short}</th>`;
  h += '<th>Strong vs</th><th>Weak vs</th></tr>';
  for (const k of keys) {
    const d0 = FACTIONS.coalition.units[k]!;
    h += `<tr><td>${roleName(k)}</td>`;
    for (const f of PLAYABLE) h += `<td>${FACTIONS[f as FactionId].units[k]!.name}</td>`;
    h += `<td class="good">${d0.strong}</td><td class="bad">${d0.weak}</td></tr>`;
  }
  h += '</table><p><b>Sythari</b> units are faster and hit harder; <b>Coalition</b> units have more armour. Equal armies trade evenly.</p>';
  return h;
}

function roleName(k: UnitKey): string {
  return (
    {
      rifle: 'General infantry',
      sniper: 'Counter-infantry',
      rocket: 'Anti-vehicle infantry',
      scout: 'Scout',
      light: 'Light combat vehicle',
      tank: 'Battle tank',
      apc: 'Transport',
      gunship: 'Gunship',
      bomber: 'Bomber',
      dropship: 'Air transport',
    } as Record<string, string>
  )[k];
}

function helpBasics(): string {
  return `<ul class="tips">
<li><b>Win</b> by destroying every enemy HQ. Lose your HQ and you're out.</li>
<li>Your <b>builder</b> builds everything (Y opens the build menu). Start with a <b>Supply Depot</b> next to your main cache, then a <b>Barracks</b>.</li>
<li><b>Supply trucks</b> carry supplies from caches to your HQ or depots. Caches run out, so expand to new ones and build a <b>Supply Drop Zone</b> for income that never ends.</li>
<li><b>Upgrade your HQ</b> to unlock vehicles (Tier 2), aircraft (Tier 3) and the superweapon (Tier 4). Each tier also raises your unit cap.</li>
<li>The <b>Fortifications Yard</b> unlocks gunner emplacements (put infantry inside), anti-air and artillery.</li>
<li><b>Fog of war</b>: you only see what your units see. Cliffs, rocks and scrub block line of sight, and units below a cliff can't see what's on top. Aircraft see over everything.</li>
<li><b>Marauders</b> hold any base nobody plays (and the central outpost). They leave you alone unless you enter their territory, but if you attack them they send raiders after you. Destroy a stronghold for a bounty and free access to its supplies.</li>
<li>Your base sits on a plateau with a wide main ramp and a narrow side ramp. Defend those chokepoints, and watch the cliff edges for air drops.</li>
<li><b>Dropships</b> fly infantry over cliffs and walls: board them (X on the dropship), fly over, then press Y to unload.</li>
</ul>`;
}
