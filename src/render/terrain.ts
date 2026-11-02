// Pre-renders the battlefield into image chunks once per match: a desert
// basin with sandy lowlands, raised plateaus, rocky cliffs, scrub "forests"
// and an oasis moat.

import { hash2, valueNoise } from '../core/math';
import { Tile, type GameMap } from '../sim/map';

export const TILE_PX = 24;
export const CHUNK = 16;

type RGB = [number, number, number];

const COL: Record<number, RGB> = {
  [Tile.Low]: [184, 156, 108],
  [Tile.High]: [204, 180, 132],
  [Tile.Cliff]: [128, 98, 68],
  [Tile.Rock]: [132, 118, 100],
  [Tile.Water]: [56, 118, 132],
  [Tile.Forest]: [150, 132, 88],
  [Tile.Ramp]: [176, 146, 98],
};

export interface TerrainArt {
  chunks: HTMLCanvasElement[];
  cols: number;
  rows: number;
  minimap: HTMLCanvasElement;
}

export function renderTerrain(map: GameMap): TerrainArt {
  const cols = Math.ceil(map.w / CHUNK);
  const rows = Math.ceil(map.h / CHUNK);
  const chunks: HTMLCanvasElement[] = [];
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) chunks.push(renderChunk(map, cx, cy));
  return { chunks, cols, rows, minimap: renderMinimapBase(map) };
}

function tileAt(map: GameMap, x: number, y: number): number {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return Tile.Low;
  return map.tiles[ty * map.w + tx];
}

const isHigh = (t: number) => t === Tile.High || t === Tile.Cliff;

function renderChunk(map: GameMap, cx: number, cy: number): HTMLCanvasElement {
  const size = CHUNK * TILE_PX;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const ox = cx * CHUNK;
  const oy = cy * CHUNK;
  for (let py = 0; py < size; py++) {
    const wy = oy + (py + 0.5) / TILE_PX;
    for (let px = 0; px < size; px++) {
      const wx = ox + (px + 0.5) / TILE_PX;
      // wobble the sampling point so tile borders look natural
      const n1 = valueNoise(wx * 1.7, wy * 1.7, 1);
      const n2 = valueNoise(wx * 1.7, wy * 1.7, 2);
      const jx = wx + (n1 - 0.5) * 0.55;
      const jy = wy + (n2 - 0.5) * 0.55;
      let t = tileAt(map, jx, jy);
      const real = tileAt(map, wx, wy);
      // keep impassable/passable borders honest near the true tile
      if ((real === Tile.Rock || real === Tile.Water || real === Tile.Cliff) !== (t === Tile.Rock || t === Tile.Water || t === Tile.Cliff)) {
        const fx = wx - Math.floor(wx);
        const fy = wy - Math.floor(wy);
        if (fx > 0.2 && fx < 0.8 && fy > 0.2 && fy < 0.8) t = real;
      }
      let [r, g, b] = COL[t];
      const big = valueNoise(wx / 5, wy / 5, 3);
      const mid = valueNoise(wx / 1.3, wy / 1.3, 4);
      const fine = hash2(Math.floor(wx * TILE_PX), Math.floor(wy * TILE_PX), 5);
      let k = 1;
      if (t === Tile.Low || t === Tile.High || t === Tile.Ramp || t === Tile.Forest) {
        k = 0.9 + big * 0.14 + mid * 0.06 + (fine - 0.5) * 0.06;
        // darker dirt patches
        if (t === Tile.Low && big > 0.62) {
          const f = Math.min(1, (big - 0.62) * 5);
          r -= 22 * f;
          g -= 22 * f;
          b -= 14 * f;
        }
        // wind ripples in the sand
        const rip = Math.sin(wx * 3.1 + wy * 1.2 + mid * 3) * 0.5 + 0.5;
        k += (rip - 0.5) * 0.03;
        if (t === Tile.Ramp) k += Math.sin(wy * 18) > 0.6 ? -0.05 : 0;
        // cast shadow below cliffs (light from the top-left)
        if (!isHigh(t)) {
          const up = tileAt(map, jx - 0.3, jy - 0.55);
          if (isHigh(up)) k *= 0.72;
        } else if (t === Tile.High) {
          // bright rim at plateau edges
          const below = tileAt(map, jx, jy + 0.35);
          if (below === Tile.Cliff) k *= 1.06;
        }
        // wet sand next to water
        if ((tileAt(map, jx + 0.3, jy) === Tile.Water || tileAt(map, jx - 0.3, jy) === Tile.Water || tileAt(map, jx, jy + 0.3) === Tile.Water || tileAt(map, jx, jy - 0.3) === Tile.Water)) {
          r -= 30;
          g -= 24;
          b -= 10;
        }
      } else if (t === Tile.Cliff) {
        const strata = Math.sin(wy * 9 + mid * 4) * 0.5 + 0.5;
        k = 0.8 + strata * 0.18 + (fine - 0.5) * 0.08;
        // the face pointing at the viewer is darker
        if (!isHigh(tileAt(map, jx, jy + 0.6))) k *= 0.78;
        if (!isHigh(tileAt(map, jx - 0.6, jy))) k *= 0.9;
      } else if (t === Tile.Rock) {
        k = 0.82 + mid * 0.22 + (fine - 0.5) * 0.1;
      } else if (t === Tile.Water) {
        // shallower (lighter) near the shore
        let shore = 0;
        for (const [dx, dy] of [
          [0.7, 0],
          [-0.7, 0],
          [0, 0.7],
          [0, -0.7],
          [1.4, 0],
          [-1.4, 0],
          [0, 1.4],
          [0, -1.4],
        ])
          if (tileAt(map, jx + dx, jy + dy) !== Tile.Water) shore += Math.abs(dx) + Math.abs(dy) < 1 ? 2 : 1;
        k = 0.82 + shore * 0.05 + (mid - 0.5) * 0.12;
        const wave = Math.sin(wx * 5 + wy * 2 + big * 6);
        if (wave > 0.85) k += 0.12;
      }
      const i = (py * size + px) * 4;
      d[i] = Math.max(0, Math.min(255, r * k));
      d[i + 1] = Math.max(0, Math.min(255, g * k));
      d[i + 2] = Math.max(0, Math.min(255, b * k));
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // decorations drawn with vector shapes
  ctx.save();
  ctx.scale(TILE_PX, TILE_PX);
  ctx.translate(-ox, -oy);
  for (let ty = oy - 1; ty < oy + CHUNK + 1; ty++)
    for (let tx = ox - 1; tx < ox + CHUNK + 1; tx++) {
      if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
      const t = map.tiles[ty * map.w + tx];
      const h = hash2(tx, ty, 9);
      if (t === Tile.Forest) drawScrub(ctx, tx, ty);
      else if (t === Tile.Rock) drawBoulders(ctx, tx, ty);
      else if ((t === Tile.Low || t === Tile.High) && h < 0.12) {
        // pebbles and dry tufts
        const x = tx + hash2(tx, ty, 10);
        const y = ty + hash2(tx, ty, 11);
        if (h < 0.05) {
          ctx.fillStyle = 'rgba(90,72,48,0.45)';
          ctx.beginPath();
          ctx.ellipse(x, y, 0.07, 0.05, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(110,104,60,0.55)';
          ctx.lineWidth = 0.03;
          ctx.beginPath();
          for (let k = -2; k <= 2; k++) {
            ctx.moveTo(x, y);
            ctx.lineTo(x + k * 0.05, y - 0.12);
          }
          ctx.stroke();
        }
      }
    }
  ctx.restore();
  return c;
}

function drawScrub(ctx: CanvasRenderingContext2D, tx: number, ty: number): void {
  const n = 2 + Math.floor(hash2(tx, ty, 12) * 2);
  for (let k = 0; k < n; k++) {
    const x = tx + 0.2 + hash2(tx, ty, 13 + k) * 0.6;
    const y = ty + 0.2 + hash2(tx, ty, 17 + k) * 0.6;
    const r = 0.28 + hash2(tx, ty, 21 + k) * 0.18;
    ctx.fillStyle = 'rgba(40,36,20,0.35)';
    ctx.beginPath();
    ctx.arc(x + 0.12, y + 0.14, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = k % 2 ? '#5a6a33' : '#4e5e2c';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(160,170,90,0.35)';
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBoulders(ctx: CanvasRenderingContext2D, tx: number, ty: number): void {
  const n = 1 + Math.floor(hash2(tx, ty, 30) * 2);
  for (let k = 0; k < n; k++) {
    const x = tx + 0.25 + hash2(tx, ty, 31 + k) * 0.5;
    const y = ty + 0.25 + hash2(tx, ty, 35 + k) * 0.5;
    const r = 0.3 + hash2(tx, ty, 39 + k) * 0.25;
    ctx.fillStyle = 'rgba(30,24,18,0.35)';
    ctx.beginPath();
    ctx.ellipse(x + 0.1, y + 0.14, r, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#7b6f60';
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.82, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(220,205,180,0.25)';
    ctx.beginPath();
    ctx.ellipse(x - r * 0.25, y - r * 0.3, r * 0.5, r * 0.35, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderMinimapBase(map: GameMap): HTMLCanvasElement {
  const s = 2;
  const c = document.createElement('canvas');
  c.width = map.w * s;
  c.height = map.h * s;
  const ctx = c.getContext('2d')!;
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      const t = map.tiles[y * map.w + x];
      let [r, g, b] = COL[t];
      if (t === Tile.Forest) [r, g, b] = [86, 100, 52];
      if (t === Tile.Cliff) [r, g, b] = [96, 74, 52];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x * s, y * s, s, s);
    }
  return c;
}
