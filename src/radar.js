// Rain radar overlay (RainViewer, observed). Frames come from our server (server/radar.js) as
// one reflectivity byte per pixel at zoom 7 (512 px tiles). Each map tile is drawn by
// interpolating those values rather than stretching coloured pixels, so the overlay stays
// smooth when zoomed in: rain/no-rain edges follow an interpolated contour, and colours blend
// between neighbouring dBZ steps.

const L = window.L;

const FRAME_MATCH_S = 10 * 60; // a past hour shows the frame within 10 minutes of it
const CACHE_MAX = 160; // decoded source tiles kept in memory (~256 KB each)
const TILE = 256;

const radar = {
  meta: null, // { grid, palette, frames }
  lut: null, // Uint8ClampedArray: RGBA per stored byte (0 = no rain)
  cache: new Map(), // "time/x/y" → Promise<Uint8Array | null>, oldest first
};

export const radarFrames = () => radar.meta?.frames ?? [];
export const latestFrame = () => radarFrames().at(-1) ?? null;

// The frame to show for a past hour: the one closest to it, if within FRAME_MATCH_S.
export function frameNear(ms) {
  let best = null;
  for (const t of radarFrames()) if (best == null || Math.abs(t * 1000 - ms) < Math.abs(best * 1000 - ms)) best = t;
  return best != null && Math.abs(best * 1000 - ms) <= FRAME_MATCH_S * 1000 ? best : null;
}

// Fetch the frame list; resolves to true when a newer frame has arrived.
export async function loadRadarFrames() {
  const res = await fetch("/api/radar", { signal: AbortSignal.timeout(45000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  if (!body.frames?.length) throw new Error(body.error ?? "no radar frames available yet");
  const before = latestFrame();
  if (!radar.lut) {
    const colors = body.palette.colors;
    radar.lut = new Uint8ClampedArray((colors.length + 1) * 4);
    colors.forEach((hex, i) => radar.lut.set([0, 2, 4, 6].map((k) => parseInt(hex.slice(k, k + 2), 16)), (i + 1) * 4));
  }
  radar.meta = body;
  return latestFrame() !== before;
}

function sourceTile(time, x, y) {
  const key = `${time}/${x}/${y}`;
  const hit = radar.cache.get(key);
  if (hit) {
    radar.cache.delete(key);
    radar.cache.set(key, hit);
    return hit;
  }
  const p = fetch(`/api/radar/${key}`)
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((buf) => (buf ? new Uint8Array(buf) : null))
    .catch(() => {
      radar.cache.delete(key); // try again next time
      return null;
    });
  radar.cache.set(key, p);
  while (radar.cache.size > CACHE_MAX) radar.cache.delete(radar.cache.keys().next().value);
  return p;
}

// Source tiles (zoom 7) overlapping a map tile, with a pixel's margin for interpolation.
function sourceRange(coords) {
  const { z, size, x0, x1, y0, y1 } = radar.meta.grid;
  const s = (2 ** (z - coords.z) * size) / TILE; // source pixels per output pixel
  const span = (start) => [Math.floor((start * TILE * s - 1) / size), Math.floor(((start + 1) * TILE * s + 1) / size)];
  const [tx0, tx1] = span(coords.x);
  const [ty0, ty1] = span(coords.y);
  return { s, tx0: Math.max(tx0, x0), tx1: Math.min(tx1, x1), ty0: Math.max(ty0, y0), ty1: Math.min(ty1, y1) };
}

// Gaussian blur radius and weights, in source pixels.
const BLUR_R = 3;
const BLUR_SIGMA = 1.2;
const BLUR_W = (() => {
  const w = Array.from({ length: 2 * BLUR_R + 1 }, (_, i) => Math.exp(-((i - BLUR_R) ** 2) / (2 * BLUR_SIGMA ** 2)));
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / total);
})();

// An n × n patch of source pixels from (x0, y0), blurred: wet = share of rain nearby (0–1),
// sum = rain-weighted band index, so sum / wet is the mean band index of the rain nearby.
function smoothPatch(at, x0, y0, n) {
  const wet = new Float32Array(n * n);
  const sum = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const b = at(x0 + x, y0 + y);
      if (b) {
        wet[y * n + x] = 1;
        sum[y * n + x] = b;
      }
    }
  }
  const tmpW = new Float32Array(n * n);
  const tmpS = new Float32Array(n * n);
  const pass = (srcW, srcS, dstW, dstS, along) => {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let w = 0;
        let s = 0;
        for (let k = -BLUR_R; k <= BLUR_R; k++) {
          const c = b + k;
          if (c < 0 || c >= n) continue;
          const idx = along ? a * n + c : c * n + a;
          w += srcW[idx] * BLUR_W[k + BLUR_R];
          s += srcS[idx] * BLUR_W[k + BLUR_R];
        }
        const out = along ? a * n + b : b * n + a;
        dstW[out] = w;
        dstS[out] = s;
      }
    }
  };
  pass(wet, sum, tmpW, tmpS, true); // along rows
  pass(tmpW, tmpS, wet, sum, false); // along columns
  return { x0, y0, n, wet, sum };
}

async function paint(canvas, coords, time, isCurrent) {
  const ctx = canvas.getContext("2d");
  if (time == null || !radar.meta) return ctx.clearRect(0, 0, TILE, TILE);
  const { s, tx0, tx1, ty0, ty1 } = sourceRange(coords);
  const keys = [];
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) keys.push([x, y]);
  const loaded = await Promise.all(keys.map(([x, y]) => sourceTile(time, x, y)));
  if (!isCurrent()) return; // a newer frame was asked for while loading
  const size = radar.meta.grid.size;
  const ny = ty1 - ty0 + 1;
  // Stored byte at a zoom-7 source pixel; 0 outside the loaded tiles.
  const at = (ix, iy) => {
    const tx = Math.floor(ix / size);
    const ty = Math.floor(iy / size);
    if (tx < tx0 || tx > tx1 || ty < ty0 || ty > ty1) return 0;
    const t = loaded[(tx - tx0) * ny + (ty - ty0)];
    return t ? t[(iy - ty * size) * size + (ix - tx * size)] : 0;
  };
  const lut = radar.lut;
  const top = (radar.lut.length >> 2) - 1;
  const img = ctx.createImageData(TILE, TILE);
  const out = img.data;
  const ox = coords.x * TILE * s;
  const oy = coords.y * TILE * s;

  // Interpolates the stored band index (linear in dBZ) over rainy pixels only, and the
  // rain/no-rain mask separately, so showers keep their size and get a soft contour edge.
  // wet: share of the neighbourhood with rain (0–1); value: mean band index over the rainy part.
  const put = (i, wet, value) => {
    let edge;
    if (s <= 1) edge = Math.min(1, (wet - 0.35) / 0.3); // magnified: contour at half coverage
    else edge = Math.min(1, wet * 2); // reduced: keep small showers visible, just fainter
    if (edge <= 0) return;
    const v = Math.min(top, Math.max(1, value));
    const lo = Math.floor(v);
    const hi = Math.min(top, lo + 1);
    const f = v - lo;
    for (let k = 0; k < 4; k++) out[i + k] = lut[lo * 4 + k] + (lut[hi * 4 + k] - lut[lo * 4 + k]) * f;
    out[i + 3] *= edge;
  };

  // Zoomed in: the radar's own grid (~1 km) shows as stair-stepped edges several source pixels
  // high, so first soften the patch under this tile (Gaussian, separable), then interpolate.
  let field = null;
  if (s <= 1) field = smoothPatch(at, Math.floor(ox) - BLUR_R - 1, Math.floor(oy) - BLUR_R - 1, Math.ceil(TILE * s) + 2 * BLUR_R + 3);

  for (let py = 0; py < TILE; py++) {
    for (let px = 0; px < TILE; px++) {
      const i = (py * TILE + px) * 4;
      if (field) {
        // Bilinear between the four nearest (smoothed) source pixel centres.
        const u = ox + (px + 0.5) * s - 0.5 - field.x0;
        const v = oy + (py + 0.5) * s - 0.5 - field.y0;
        const ix = Math.floor(u);
        const iy = Math.floor(v);
        const fx = u - ix;
        const fy = v - iy;
        const k = iy * field.n + ix;
        const n = field.n;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const wet = field.wet[k] * w00 + field.wet[k + 1] * w10 + field.wet[k + n] * w01 + field.wet[k + n + 1] * w11;
        const sum = field.sum[k] * w00 + field.sum[k + 1] * w10 + field.sum[k + n] * w01 + field.sum[k + n + 1] * w11;
        if (wet > 0.001) put(i, wet, sum / wet);
      } else {
        // Zoomed out: average the block of source pixels under this output pixel.
        const bx = Math.floor(ox + px * s);
        const by = Math.floor(oy + py * s);
        let n = 0;
        let sum = 0;
        for (let y = by; y < by + s; y++) {
          for (let x = bx; x < bx + s; x++) {
            const b = at(x, y);
            if (b) {
              n++;
              sum += b;
            }
          }
        }
        if (n) put(i, n / (s * s), sum / n);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

export const RadarLayer = L.GridLayer.extend({
  options: { pane: "radar", opacity: 0.75, maxZoom: 14, updateWhenZooming: false, attribution: 'Weather data by <a href="https://www.rainviewer.com/">RainViewer</a>' },

  initialize(options) {
    L.setOptions(this, options);
    this._frame = null;
  },

  // Repaints tiles in place (no flicker); each keeps its old picture until the new one is ready.
  setFrame(time) {
    if (time === this._frame) return;
    this._frame = time;
    for (const { el, coords } of Object.values(this._tiles ?? {})) paint(el, coords, time, () => this._frame === time);
  },

  createTile(coords, done) {
    const canvas = L.DomUtil.create("canvas", "radar-tile");
    canvas.width = canvas.height = TILE;
    const time = this._frame;
    paint(canvas, coords, time, () => true).then(
      () => done(null, canvas),
      (error) => done(error, canvas),
    );
    return canvas;
  },

  // Start loading the source tiles of other frames for the current view, so stepping or
  // playing through the timeline does not wait on the network.
  prefetch(times) {
    if (!this._map || !radar.meta) return;
    const { z, x0, x1, y0, y1 } = radar.meta.grid;
    const b = this._map.getBounds();
    const p1 = this._map.project(b.getNorthWest(), z).divideBy(radar.meta.grid.size).floor();
    const p2 = this._map.project(b.getSouthEast(), z).divideBy(radar.meta.grid.size).floor();
    for (const t of times) {
      for (let x = Math.max(p1.x, x0); x <= Math.min(p2.x, x1); x++) for (let y = Math.max(p1.y, y0); y <= Math.min(p2.y, y1); y++) sourceTile(t, x, y);
    }
  },
});
