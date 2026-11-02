// Synthesised sound effects (no audio files needed).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let volume = 0.7;
const last = new Map<string, number>();
let noiseBuf: AudioBuffer | null = null;

export function setSound(on: boolean, vol = volume): void {
  enabled = on;
  volume = vol;
  if (master) master.gain.value = volume;
}

export function unlockAudio(): void {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      const len = ctx.sampleRate;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

function tone(freq: number, dur: number, type: OscillatorType, vol: number, slide = 0, delay = 0): void {
  if (!ctx || !master) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, vol: number, filter: number, delay = 0, type: BiquadFilterType = 'lowpass'): void {
  if (!ctx || !master || !noiseBuf) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = filter;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

const GAP: Record<string, number> = { rifle: 60, mg: 70, laser: 70, boom: 90 };

/** Plays a named effect; `v` scales the volume (e.g. by distance). */
export function sfx(name: string, v = 1): void {
  if (!enabled || !ctx || v <= 0.02) return;
  const now = performance.now();
  if (now - (last.get(name) ?? 0) < (GAP[name] ?? 40)) return;
  last.set(name, now);
  switch (name) {
    case 'rifle':
      noise(0.06, 0.12 * v, 2400);
      break;
    case 'mg':
      noise(0.05, 0.1 * v, 1800);
      tone(90, 0.05, 'square', 0.03 * v);
      break;
    case 'sniper':
      noise(0.18, 0.22 * v, 3200);
      tone(1400, 0.12, 'triangle', 0.04 * v, -1200);
      break;
    case 'laser':
      tone(1100, 0.09, 'sawtooth', 0.035 * v, -700);
      break;
    case 'beam':
      tone(500, 0.3, 'sawtooth', 0.05 * v, 900);
      tone(760, 0.3, 'sine', 0.04 * v, 600);
      break;
    case 'rocket':
      noise(0.35, 0.12 * v, 900);
      tone(220, 0.3, 'sawtooth', 0.03 * v, -120);
      break;
    case 'plasma':
      tone(260, 0.25, 'sine', 0.08 * v, 520);
      tone(130, 0.25, 'square', 0.03 * v, 200);
      break;
    case 'cannon':
      noise(0.3, 0.25 * v, 500);
      tone(70, 0.3, 'sine', 0.18 * v, -30);
      break;
    case 'arty':
      noise(0.5, 0.25 * v, 350);
      tone(55, 0.45, 'sine', 0.18 * v, -20);
      break;
    case 'missile':
      noise(0.4, 0.1 * v, 2500, 0, 'bandpass');
      break;
    case 'boom':
      noise(0.5, 0.3 * v, 600);
      tone(60, 0.4, 'sine', 0.2 * v, -30);
      break;
    case 'bigboom':
      noise(1.2, 0.45 * v, 400);
      tone(40, 1.0, 'sine', 0.35 * v, -15);
      break;
    case 'click':
      tone(880, 0.04, 'square', 0.03);
      break;
    case 'select':
      tone(660, 0.05, 'triangle', 0.05);
      tone(990, 0.06, 'triangle', 0.04, 0, 0.04);
      break;
    case 'move':
      tone(520, 0.06, 'triangle', 0.05);
      break;
    case 'attack':
      tone(330, 0.08, 'square', 0.04);
      tone(250, 0.1, 'square', 0.04, 0, 0.06);
      break;
    case 'error':
      tone(200, 0.15, 'square', 0.05, -60);
      break;
    case 'alert':
      tone(880, 0.12, 'square', 0.05);
      tone(660, 0.16, 'square', 0.05, 0, 0.14);
      break;
    case 'done':
      tone(660, 0.08, 'triangle', 0.05);
      tone(880, 0.08, 'triangle', 0.05, 0, 0.08);
      tone(1320, 0.12, 'triangle', 0.05, 0, 0.16);
      break;
    case 'warn':
      for (let i = 0; i < 3; i++) tone(440, 0.2, 'sawtooth', 0.05, 220, i * 0.25);
      break;
    case 'drop':
      tone(300, 0.6, 'sine', 0.04, 400);
      break;
  }
}

/** Gamepad and phone rumble. */
export function rumble(ms: number, strength = 0.5): void {
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      const act = (p as any)?.vibrationActuator;
      if (act?.playEffect) act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength });
    }
  } catch {
    /* not supported */
  }
}
