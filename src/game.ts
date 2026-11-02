// The game shell: menus, starting matches (local, online host, online guest),
// the frame loop and wiring between simulation, rendering, input and HUD.

import { rumble, setSound, sfx, unlockAudio } from './core/audio';
import { clamp } from './core/math';
import { SLOT_NAMES, type FactionId } from './data/defs';
import { Input } from './input/input';
import { applySnapshot, interpolate, type LobbyState, type Snapshot } from './net/protocol';
import { GuestSession, HostSession } from './net/session';
import { hostLocal, hostOnline, joinLocal, joinOnline } from './net/transport';
import { Renderer } from './render/renderer';
import { SkirmishAI } from './sim/ai';
import { applyCommand, type Command } from './sim/commands';
import type { FxEvent } from './sim/entities';
import { createMatch } from './sim/match';
import { World, type MatchSetup, type SlotSetup } from './sim/world';
import { Controller } from './ui/controller';
import { Hud } from './ui/hud';
import { Screens, type Settings } from './ui/screens';

const STEP = 1 / 30;
const SNAP_INTERVAL = 0.1;

type Mode = 'local' | 'host' | 'guest';

function loadSettings(): Settings {
  const def: Settings = { sound: true, quality: 'high', touch: 'auto', name: 'Commander' };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem('sf-settings') ?? '{}') };
  } catch {
    return def;
  }
}

/** Uses same-browser tabs instead of the internet when the page is opened with ?net=local. */
const LOCAL_NET = new URLSearchParams(location.search).get('net') === 'local';

export class Game {
  readonly input = new Input();
  readonly screens: Screens;
  settings = loadSettings();
  world: World | null = null;
  renderer: Renderer | null = null;
  ctl: Controller | null = null;
  hud: Hud | null = null;
  mode: Mode = 'local';
  me = 0;
  host: HostSession | null = null;
  guest: GuestSession | null = null;
  paused = false;
  private acc = 0;
  private snapT = 0;
  private lastSnapAt = 0;
  private pendingSnap: Snapshot | null = null;
  private fogT = 0;
  private endT = -1;
  private last = performance.now();
  private canvas: HTMLCanvasElement;
  private lobbyPoll = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private ui: HTMLElement,
  ) {
    this.canvas = canvas;
    setSound(this.settings.sound);
    this.screens = new Screens(ui, this.input, {
      startSkirmish: (l) => this.startSkirmish(l),
      hostOnline: () => this.hostGame(),
      joinOnline: (code) => this.joinGame(code),
      startOnline: () => this.startHosted(),
      setLobby: (l) => {
        if (this.host) {
          this.host.lobby = l;
          this.host.broadcastLobby();
        }
      },
      pickFaction: (f) => this.guest?.pick(f),
      leaveOnline: () => this.leaveOnline(),
      resume: () => this.resume(),
      surrender: () => this.surrender(),
      quit: () => this.quit(),
      saveSettings: (s) => this.saveSettings(s),
    }, this.settings);
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('gamepadconnected', unlock);
    window.addEventListener('resize', () => this.renderer?.resize());
  }

  start(): void {
    this.screens.title();
    const frame = (now: number) => {
      this.frame(now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private saveSettings(s: Settings): void {
    this.settings = s;
    setSound(s.sound);
    if (this.renderer) this.renderer.maxDpr = s.quality === 'high' ? 2 : 1;
    try {
      localStorage.setItem('sf-settings', JSON.stringify(s));
    } catch {
      /* storage unavailable */
    }
  }

  // ---------------------------------------------------------------- frame loop

  private frame(now: number): void {
    const dt = clamp((now - this.last) / 1000, 0, 0.1);
    this.last = now;
    this.input.poll();
    if (this.screens.open) this.screens.update(dt);
    const w = this.world;
    if (!w || !this.renderer || !this.ctl || !this.hud) {
      if (!this.screens.open) this.screens.title();
      return;
    }

    if (this.mode !== 'guest') {
      if (!this.paused || this.mode === 'host') {
        this.acc += dt;
        let steps = 0;
        while (this.acc >= STEP && steps < 4) {
          w.update(STEP);
          this.acc -= STEP;
          steps++;
        }
        if (steps === 4) this.acc = 0;
      }
    } else {
      if (this.pendingSnap) {
        applySnapshot(w, this.pendingSnap);
        this.pendingSnap = null;
      }
      interpolate(w, (now - this.lastSnapAt) / 1000 / SNAP_INTERVAL, dt);
      this.fogT -= dt;
      if (this.fogT <= 0) {
        this.fogT = 0.1;
        w.updateFog(w.players[this.me].team);
      }
    }

    // visual effects to the renderer (and to guests)
    const fx: FxEvent[] = w.fx.splice(0);
    this.renderer.addFx(fx, this.me);
    if (this.host) {
      this.host.bufferFx(fx);
      this.snapT -= dt;
      if (this.snapT <= 0) {
        this.snapT = SNAP_INTERVAL;
        this.host.sendSnapshots(w);
      }
    }

    const menu = this.screens.open;
    this.ctl.enabled = !menu;
    if (!menu) this.ctl.update(dt);
    this.hud.update(dt);
    this.renderer.draw(this.ctl.view(), dt);

    if (w.over && this.endT < 0) this.endT = 2.5;
    if (this.endT > 0) {
      this.endT -= dt;
      if (this.endT <= 0) {
        this.endT = 0;
        this.screens.end(w, this.me);
        sfx(w.won(this.me) ? 'done' : 'warn');
      }
    }
  }

  // ---------------------------------------------------------------- starting matches

  private lobbyToSetup(l: LobbyState, me: number, mode: Mode): MatchSetup {
    const slots: SlotSetup[] = l.slots.map((s, i) => {
      if (s.kind === 'marauder' || s.kind === 'open') return { kind: 'marauder', faction: 'marauder' as FactionId, team: -1, name: 'Marauders' };
      if (s.kind === 'ai') return { kind: 'ai', faction: s.faction, team: s.team, name: `${SLOT_NAMES[i]} AI`, difficulty: s.difficulty };
      const name = mode === 'local' ? 'You' : s.name;
      return { kind: i === me ? 'local' : 'remote', faction: s.faction, team: s.team, name };
    });
    return { slots, centerOutpost: l.centerOutpost, viewer: me };
  }

  private startSkirmish(l: LobbyState): void {
    this.mode = 'local';
    this.launch(this.lobbyToSetup(l, 0, 'local'), 0);
  }

  private launch(setup: MatchSetup, me: number): void {
    this.screens.loading('Deploying forces…');
    // let the loading screen paint before the terrain is generated
    setTimeout(() => {
      this.teardown();
      this.me = me;
      const world = this.mode === 'guest' ? new World({ ...setup, viewer: me }, true) : createMatch({ ...setup, viewer: me });
      world.viewer = me;
      this.world = world;
      const r = new Renderer(this.canvas, world);
      r.maxDpr = this.settings.quality === 'high' ? 2 : 1;
      this.renderer = r;
      const start = world.map.starts[me];
      r.cam.x = start.hq.x + 2;
      r.cam.y = start.hq.y + 1;
      r.cam.zoom = window.innerWidth < 900 ? 30 : 36;
      r.onVisibleFx = (e, d) => this.fxSound(e, d);
      this.ctl = new Controller(r, this.input, {
        world: () => this.world!,
        me: () => this.me,
        issue: (cmd) => this.issue(cmd),
        toast: (t, k) => this.hud?.toast(t, k),
        pause: () => this.pause(),
        stats: () => this.world && this.screens.stats(this.world, this.me, () => this.resume()),
        alerts: () => (this.world ? this.world.alerts.filter((a) => a.owner === this.me) : []),
      });
      this.hud = new Hud(this.ui, () => this.world!, () => this.me, this.ctl, r, this.input);
      this.hud.showTouch = () => (this.settings.touch === 'on' ? true : this.settings.touch === 'off' ? false : this.input.device === 'touch');
      this.hud.onPause = () => this.pause();
      this.hud.onAlert = (a) => {
        if (a.kind === 'attack') {
          sfx('alert');
          rumble(120, 0.4);
        } else if (a.kind === 'done') sfx('done');
        else if (a.kind === 'warn') sfx('warn');
      };
      this.paused = false;
      this.acc = 0;
      this.endT = -1;
      this.screens.close();
      this.hud.toast(this.mode === 'local' ? 'Battle started. Build a Supply Depot and a Barracks with your builder (Y).' : 'Online battle started. Good luck, Commander.', 'info');
    }, 30);
  }

  private teardown(): void {
    this.hud?.root.remove();
    this.hud = null;
    this.ctl = null;
    this.renderer = null;
    this.world = null;
    // a fresh canvas drops the old input listeners
    const fresh = this.canvas.cloneNode() as HTMLCanvasElement;
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
  }

  issue(cmd: Command): string {
    const w = this.world;
    if (!w) return '';
    if (this.mode === 'guest') {
      this.guest?.send(cmd);
      return '';
    }
    return applyCommand(w, this.me, cmd);
  }

  private fxSound(e: FxEvent, d: number): void {
    const v = clamp(1 - d / 26, 0, 1);
    if (v <= 0.05) return;
    switch (e.k) {
      case 'shot': {
        const map: Record<string, string> = { bullet: 'rifle', sniper: 'sniper', laser: 'laser', beam: 'beam', rocket: 'rocket', plasma: 'plasma', shell: 'cannon', arty: 'arty', missile: 'missile' };
        const n = map[e.fx];
        if (n) sfx(n, v * 0.7);
        break;
      }
      case 'explode':
        sfx(e.size > 2.5 ? 'bigboom' : 'boom', v);
        if (e.size > 2.5 && d < 12) rumble(200, 0.6);
        break;
      case 'super':
        if (e.phase === 'hit') {
          sfx('bigboom', 1);
          rumble(600, 1);
        }
        break;
      case 'drop':
        sfx('drop', v);
        break;
    }
  }

  // ---------------------------------------------------------------- online

  private async hostGame(): Promise<string> {
    this.leaveOnline(true);
    const t = LOCAL_NET ? await hostLocal() : await hostOnline();
    const lobby = this.screens.lobby;
    void lobby;
    this.screens.hostLobby(t.code);
    const session = new HostSession(t, this.screens.lobby);
    session.lobby.slots[0].name = this.settings.name;
    this.host = session;
    this.mode = 'host';
    session.onLobby = () => this.screens.refreshHostLobby(session.lobby);
    session.onCommand = (slot, cmd) => (this.world ? applyCommand(this.world, slot, cmd) : 'Not started');
    session.onGuestLeft = (slot, name) => {
      if (!this.world) return;
      const p = this.world.players[slot];
      if (!p || p.defeated) return;
      // a computer player takes over for whoever left
      this.world.controllers.push(new SkirmishAI(this.world, slot, 'normal'));
      p.name = `${name} (AI)`;
      this.hud?.toast(`${name} disconnected - the AI takes over their base`, 'warn');
    };
    return t.code;
  }

  private startHosted(): void {
    const h = this.host;
    if (!h) return;
    const setup = this.lobbyToSetup(h.lobby, 0, 'host');
    // each guest gets the same setup, with their own slot marked as theirs
    h.start(setup);
    this.mode = 'host';
    this.launch(setup, 0);
  }

  private async joinGame(code: string): Promise<void> {
    this.leaveOnline(true);
    const link = LOCAL_NET ? await joinLocal(code) : await joinOnline(code);
    const g = new GuestSession(link, this.settings.name);
    this.guest = g;
    this.mode = 'guest';
    g.onLobby = () => {
      if (g.lobby && !this.world) this.screens.guestLobby(g.lobby, g.slot);
    };
    g.onStart = (setup, slot) => {
      this.mode = 'guest';
      this.launch(setup, slot);
    };
    g.onSnap = (s) => {
      this.pendingSnap = s;
      this.lastSnapAt = performance.now();
    };
    g.onRes = (text) => this.hud?.toast(text, 'error');
    g.onBye = (reason) => {
      this.guest = null;
      if (this.world && this.world.over) return;
      this.teardown();
      this.mode = 'local';
      this.screens.message('Disconnected', reason, () => this.screens.title());
    };
    void this.lobbyPoll;
  }

  private leaveOnline(silent = false): void {
    if (this.host) {
      this.host.close();
      this.host = null;
    }
    if (this.guest) {
      this.guest.close();
      this.guest = null;
    }
    this.mode = 'local';
    if (!silent) this.screens.online();
  }

  // ---------------------------------------------------------------- pause / end

  pause(): void {
    if (!this.world || this.world.over) return;
    if (this.mode === 'local') this.paused = true;
    this.screens.pause(this.mode !== 'local');
  }

  resume(): void {
    this.paused = false;
    this.screens.close();
    this.input.consume();
  }

  private surrender(): void {
    this.issue({ c: 'surrender' });
    this.resume();
  }

  quit(): void {
    if (this.host) {
      this.host.close();
      this.host = null;
    }
    if (this.guest) {
      this.guest.close();
      this.guest = null;
    }
    this.teardown();
    this.mode = 'local';
    this.paused = false;
    this.screens.title();
  }

  /** Android back button: close menus, cancel, or pause. Returns true if handled. */
  back(): boolean {
    if (this.screens.open) {
      if (this.screens.current === 'title') return false;
      if (this.world && (this.screens.current === 'pause' || this.screens.current === 'stats')) this.resume();
      else if (!this.world) this.screens.title();
      return true;
    }
    if (this.ctl && (this.ctl.mode !== 'normal' || this.ctl.selected.length || this.ctl.building)) {
      this.ctl.cancel();
      return true;
    }
    this.pause();
    return true;
  }
}
