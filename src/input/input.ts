// Raw input: gamepad buttons/sticks with edge detection, the keyboard, and
// which kind of device the player last used (so the HUD can adapt).

export const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

export type Device = 'gamepad' | 'touch' | 'mouse';

const DEAD = 0.2;

export class Input {
  device: Device = 'ontouchstart' in window ? 'touch' : 'mouse';
  onDevice: ((d: Device) => void) | null = null;
  padConnected = false;
  private btn: boolean[] = [];
  private prev: boolean[] = [];
  private downAt: number[] = [];
  axes = [0, 0, 0, 0];
  /** Keys currently held (lower-case `key`). */
  keys = new Set<string>();
  /** Keys pressed since the last frame. */
  keyQueue: KeyboardEvent[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const k = e.key.toLowerCase();
      if (!this.keys.has(k)) this.keyQueue.push(e);
      this.keys.add(k);
      if ([' ', 'tab', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
      this.setDevice('mouse');
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', () => {
      this.padConnected = true;
      this.setDevice('gamepad');
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.padConnected = false;
    });
    window.addEventListener('pointerdown', (e) => this.setDevice(e.pointerType === 'touch' ? 'touch' : 'mouse'), true);
  }

  setDevice(d: Device): void {
    if (d === this.device) return;
    this.device = d;
    this.onDevice?.(d);
  }

  /** Reads the first connected gamepad. Call once per frame. */
  poll(): void {
    this.prev = this.btn;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
    this.padConnected = !!pad;
    if (!pad) {
      this.btn = [];
      this.axes = [0, 0, 0, 0];
      return;
    }
    const now = performance.now();
    this.btn = pad.buttons.map((b, i) => (i === 6 || i === 7 ? b.value > 0.4 : b.pressed || b.value > 0.5));
    for (let i = 0; i < this.btn.length; i++) if (this.btn[i] && !this.prev[i]) this.downAt[i] = now;
    const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));
    this.axes = [dz(pad.axes[0] ?? 0), dz(pad.axes[1] ?? 0), dz(pad.axes[2] ?? 0), dz(pad.axes[3] ?? 0)];
    if (this.btn.some(Boolean) || this.axes.some((a) => a !== 0)) this.setDevice('gamepad');
  }

  pressed(i: number): boolean {
    return !!this.btn[i] && !this.prev[i];
  }
  released(i: number): boolean {
    return !this.btn[i] && !!this.prev[i];
  }
  held(i: number): boolean {
    return !!this.btn[i];
  }
  heldFor(i: number): number {
    return this.btn[i] ? (performance.now() - (this.downAt[i] ?? 0)) / 1000 : 0;
  }

  /** Swallow presses (e.g. when a menu opens so the press doesn't leak into the game). */
  consume(): void {
    this.prev = this.btn.slice();
    this.keyQueue = [];
  }
}
