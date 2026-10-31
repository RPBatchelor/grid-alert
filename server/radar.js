// Rain radar (RainViewer, observed): keeps a rolling history of radar frames over Victoria on
// disk, so the client can step back further than RainViewer's own ~2 hours and every viewer is
// served from here rather than from RainViewer directly (their API asks users to cache).
//
// RainViewer's free tiles stop at zoom 7, but a 512 px tile at zoom 7 carries zoom-8 detail.
// We fetch the raw colours (no RainViewer smoothing), turn each pixel back into reflectivity
// (dBZ) with RainViewer's published colour table, and store that as one byte per pixel; the
// client interpolates and colours it (src/radar.js).
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gzipSync, inflateSync } from "node:zlib";
import { historyPath } from "./history.js";

const UA = "GridAlertVictoria/0.2 (+https://grid-alert.com)";
const DIR = resolve(process.env.RADAR_DIR ?? join(dirname(historyPath), "radar"));
const KEEP_HOURS = Number(process.env.RADAR_KEEP_HOURS ?? 24);
const POLL_MS = 5 * 60000; // RainViewer publishes a frame every 10 minutes

// Zoom-7 tiles covering Victoria with a margin, so the map's outer edges are not empty.
const AREA = { west: 138, east: 152, north: -32, south: -41.5 };
const Z = 7;
const SIZE = 512;
const tileX = (lon) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const tileY = (lat) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** Z);
};
export const RADAR_GRID = { z: Z, size: SIZE, x0: tileX(AREA.west), x1: tileX(AREA.east), y0: tileY(AREA.north), y1: tileY(AREA.south) };

// RainViewer "Universal Blue" (colour scheme 2), dBZ -10 to 64, as RRGGBBAA
// (https://www.rainviewer.com/files/rainviewer_api_colors_table.csv). The client colours with
// the same table, so the overlay looks as before, only smoother.
const PALETTE_MIN_DBZ = -10;
const PALETTE = (
  "63615914 66635a19 69665c1e 6c685d24 6f6b5f29 726e612e 75706234 78736439 7c75653e 7f786744 827b6949 857d6a4e 88806c54 8b826d59 8e856f5e " +
  "92887164 9e93756e aa9e7978 b6a97e82 c2b4828c cec08796 d2c48ba0 d6c88faa dacc93b4 ded097be 88ddeeff 6cd1ebff 51c5e8ff 36bae5ff 1baee2ff " +
  "00a3e0ff 009ad5ff 0091caff 0088bfff 007fb4ff 0077aaff 0070a3ff 00699cff 006295ff 005b8eff 005588ff 005180ff 004e78ff 004a70ff 004768ff " +
  "ffee00ff ffe000ff ffd200ff ffc500ff ffb700ff ffaa00ff ff9f00ff ff9500ff ff8b00ff ff8100ff ff4400ff f23600ff e62800ff d91b00ff cd0d00ff " +
  "c10000ff a80000ff 8f0000ff 760000ff 5d0000ff ffaaffff ff9fffff ff95ffff ff8bffff ff81ffff ff77ffff ff6cffff ff62ffff ff58ffff ff4effff"
).split(" ");
// Stored byte per pixel: 0 = no rain, otherwise 1 + index into PALETTE. Colours past the table
// (RainViewer's hail/test colours) count as the strongest band.
const BYTE_OF = new Map(PALETTE.map((hex, i) => [parseInt(hex, 16) >>> 0, i + 1]));
BYTE_OF.set(0xffffffff, PALETTE.length).set(0x00ff00ff, PALETTE.length);

// Minimal PNG decoder for RainViewer's tiles (8-bit RGBA or palette), returning one byte per
// pixel as above.
function pngToBytes(buf) {
  let p = 8;
  let w, h, depth, type, plte, trns;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString("ascii", p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") [w, h, depth, type] = [d.readUInt32BE(0), d.readUInt32BE(4), d[8], d[9]];
    else if (kind === "PLTE") plte = d;
    else if (kind === "tRNS") trns = d;
    else if (kind === "IDAT") idat.push(d);
    p += 12 + len;
  }
  if (depth !== 8 || (type !== 6 && type !== 3) || buf[28] /* interlace */) throw new Error(`Unexpected radar PNG format (type ${type}, depth ${depth})`);
  const bpp = type === 6 ? 4 : 1;
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (line[i] + pred) & 255;
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let rgba;
    if (type === 6) rgba = px.readUInt32BE(i * 4);
    else {
      const k = px[i];
      rgba = ((plte[k * 3] << 24) | (plte[k * 3 + 1] << 16) | (plte[k * 3 + 2] << 8) | (trns && k < trns.length ? trns[k] : 255)) >>> 0;
    }
    out[i] = (rgba & 255) === 0 ? 0 : (BYTE_OF.get(rgba) ?? 0);
  }
  return out;
}

let frames = []; // unix seconds, ascending; only frames with every tile on disk
let lastSync = 0;
let syncing = null;
let timer = null;
let lastError = null;

const frameDir = (time) => join(DIR, String(time));

async function loadFromDisk() {
  await mkdir(DIR, { recursive: true });
  const names = await readdir(DIR);
  // Unfinished downloads live in "<time>.part" folders; clear them out.
  await Promise.all(names.filter((n) => n.endsWith(".part")).map((n) => rm(join(DIR, n), { recursive: true, force: true })));
  frames = names.filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
}

async function fetchOk(url, as) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
  return as === "json" ? res.json() : Buffer.from(await res.arrayBuffer());
}

// Download every tile of one frame into a temporary folder, then rename it into place, so a
// frame is either complete or absent.
async function download(host, frame) {
  const part = `${frameDir(frame.time)}.part`;
  await mkdir(part, { recursive: true });
  const jobs = [];
  for (let x = RADAR_GRID.x0; x <= RADAR_GRID.x1; x++) for (let y = RADAR_GRID.y0; y <= RADAR_GRID.y1; y++) jobs.push([x, y]);
  try {
    // A few at a time: kind to RainViewer and to the Pi.
    for (let i = 0; i < jobs.length; i += 4) {
      await Promise.all(
        jobs.slice(i, i + 4).map(async ([x, y]) => {
          const png = await fetchOk(`${host}${frame.path}/${SIZE}/${Z}/${x}/${y}/2/0_0.png`);
          await writeFile(join(part, `${x}-${y}.bin.gz`), gzipSync(pngToBytes(png)));
        }),
      );
    }
    await rename(part, frameDir(frame.time));
  } catch (error) {
    await rm(part, { recursive: true, force: true });
    throw error;
  }
}

async function prune() {
  const cutoff = Date.now() / 1000 - KEEP_HOURS * 3600;
  const old = frames.filter((t) => t < cutoff);
  frames = frames.filter((t) => t >= cutoff);
  await Promise.all(old.map((t) => rm(frameDir(t), { recursive: true, force: true })));
}

async function sync() {
  try {
    if (!lastSync) await loadFromDisk();
    const meta = await fetchOk("https://api.rainviewer.com/public/weather-maps.json", "json");
    const have = new Set(frames);
    // Newest first, so a fresh install has the current frame within seconds.
    for (const frame of [...(meta.radar?.past ?? [])].reverse()) {
      if (have.has(frame.time)) continue;
      await download(meta.host, frame);
      frames.push(frame.time);
      frames.sort((a, b) => a - b);
    }
    await prune();
    lastError = null;
  } catch (error) {
    lastError = error.message;
    console.error("Radar sync failed:", error.message);
  } finally {
    lastSync = Date.now();
  }
}

function syncNow() {
  syncing ??= sync().finally(() => (syncing = null));
  return syncing;
}

export function startRadar() {
  if (timer) return;
  timer = setInterval(syncNow, POLL_MS);
  timer.unref?.();
  syncNow();
}

export function stopRadar() {
  clearInterval(timer);
  timer = null;
}

// Frame list for the client. Starts a sync if the poller has fallen behind (or is not running),
// and on a fresh install waits for the first frame rather than the whole backlog.
export async function getRadarFrames() {
  if (Date.now() - lastSync > POLL_MS + 60000) syncNow();
  for (let i = 0; i < 60 && syncing && !frames.length; i++) await new Promise((r) => setTimeout(r, 500));
  return {
    grid: RADAR_GRID,
    palette: { minDbz: PALETTE_MIN_DBZ, colors: PALETTE },
    frames,
    latestAgeSeconds: frames.length ? Math.round(Date.now() / 1000 - frames.at(-1)) : null,
    error: frames.length ? null : lastError,
  };
}

// One tile of one frame: SIZE × SIZE bytes (see BYTE_OF), gzip-compressed.
export async function getRadarTile(time, x, y) {
  if (!frames.includes(time) || x < RADAR_GRID.x0 || x > RADAR_GRID.x1 || y < RADAR_GRID.y0 || y > RADAR_GRID.y1) return null;
  try {
    return await readFile(join(frameDir(time), `${x}-${y}.bin.gz`));
  } catch {
    return null;
  }
}
