// Leaflet layer rendering the forecast grid as a coloured field, with optional wind arrows or animation.
// Used when no Windy API key is configured (Windy then provides its own rendering).
import { sampler } from "./intel.js";

const L = window.L;

export const SCALES = {
  speed: { unit: "km/h", stops: [[0, "#3a4fa8"], [10, "#3384c4"], [20, "#33a59b"], [35, "#4fb547"], [55, "#d6c13a"], [70, "#e0752c"], [90, "#d1304a"], [110, "#a5267f"]] },
  gust: { unit: "km/h", stops: [[0, "#3a4fa8"], [20, "#3384c4"], [35, "#33a59b"], [50, "#4fb547"], [65, "#d6c13a"], [80, "#e0752c"], [100, "#d1304a"], [125, "#a5267f"]] },
  rain: { unit: "mm/h", stops: [[0, "rgba(0,0,0,0)"], [0.2, "#3c7fc9"], [1, "#2fb0c8"], [3, "#4fbf55"], [6, "#e2c93a"], [10, "#e57b2d"], [20, "#d13050"], [40, "#a3279a"]] },
  temp: { unit: "°C", stops: [[-2, "#6a4fb8"], [5, "#3a6fc4"], [12, "#2fa9b5"], [18, "#58b851"], [24, "#d7c43a"], [30, "#e47c2a"], [36, "#d3343c"], [42, "#8c1c5c"]] },
};

const parseColor = (() => {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  return (c) => {
    if (cache.has(c)) return cache.get(c);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const d = [...ctx.getImageData(0, 0, 1, 1).data];
    cache.set(c, d);
    return d;
  };
})();

export function colorAt(variable, value) {
  const stops = SCALES[variable].stops;
  if (value <= stops[0][0]) return parseColor(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (value <= stops[i][0]) {
      const [v0, c0] = stops[i - 1];
      const [v1, c1] = stops[i];
      const k = (value - v0) / (v1 - v0);
      const a = parseColor(c0);
      const b = parseColor(c1);
      return a.map((x, j) => x + (b[j] - x) * k);
    }
  }
  return parseColor(stops.at(-1)[1]);
}

export const WindField = L.Layer.extend({
  options: { variable: "speed", windStyle: "arrows", opacity: 0.62, pane: "weather" },

  initialize(options) {
    L.setOptions(this, options);
    this.weather = null;
    this.t = 0;
  },

  setData(weather, t) {
    if (!weather.u) {
      // Screen-space components; direction is where the wind blows FROM.
      weather.u = weather.speed.map((row, ti) => row.map((s, i) => (s == null ? null : -Math.sin((weather.direction[ti][i] * Math.PI) / 180) * s)));
      weather.v = weather.speed.map((row, ti) => row.map((s, i) => (s == null ? null : Math.cos((weather.direction[ti][i] * Math.PI) / 180) * s)));
    }
    this.weather = weather;
    this.sample = sampler(weather);
    this.t = t;
    this._redraw();
  },

  setTime(t) {
    this.t = t;
    this._redraw();
  },

  setVariable(variable) {
    this.options.variable = variable;
    this._redraw();
  },

  setOpacity(opacity) {
    this.options.opacity = opacity;
    if (this.field) this.field.style.opacity = opacity;
  },

  // "arrows" | "animated" | "none" — only drawn while a wind variable is shown.
  setWindStyle(style) {
    this.options.windStyle = style;
    this._redraw();
  },

  onAdd(map) {
    this._map = map;
    const pane = map.getPane(this.options.pane);
    this.field = L.DomUtil.create("canvas", "wind-field leaflet-zoom-hide", pane);
    this.overlay = L.DomUtil.create("canvas", "wind-overlay leaflet-zoom-hide", pane);
    this.field.style.opacity = this.options.opacity;
    map.on("movestart zoomstart", this._stop, this);
    map.on("moveend zoomend resize", this._redraw, this);
    this._redraw();
  },

  onRemove(map) {
    this._stop();
    map.off("movestart zoomstart", this._stop, this);
    map.off("moveend zoomend resize", this._redraw, this);
    L.DomUtil.remove(this.field);
    L.DomUtil.remove(this.overlay);
  },

  _stop() {
    cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.overlay) this.overlay.getContext("2d").clearRect(0, 0, this.overlay.width, this.overlay.height);
  },

  _redraw() {
    if (!this._map || !this.weather) return;
    this._stop();
    const map = this._map;
    const size = map.getSize();
    if (!size.x || !size.y) return;
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    for (const c of [this.field, this.overlay]) {
      c.width = size.x;
      c.height = size.y;
      L.DomUtil.setPosition(c, topLeft);
    }
    this._drawField(size);
    const windShown = this.options.variable === "speed" || this.options.variable === "gust";
    if (!windShown) return;
    if (this.options.windStyle === "arrows") this._drawArrows(size);
    if (this.options.windStyle === "animated") this._animate(size);
  },

  _drawField(size) {
    const v = this.options.variable;
    if (!SCALES[v]) return;
    const ctx = this.field.getContext("2d");
    const cell = 6;
    const cols = Math.ceil(size.x / cell);
    const rows = Math.ceil(size.y / cell);
    const img = ctx.createImageData(cols, rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const ll = this._map.containerPointToLatLng([x * cell + cell / 2, y * cell + cell / 2]);
        const value = this.sample(v, this.t, ll.lat, ll.lng);
        if (value == null) continue;
        const c = colorAt(v, value);
        const i = (y * cols + x) * 4;
        img.data[i] = c[0];
        img.data[i + 1] = c[1];
        img.data[i + 2] = c[2];
        img.data[i + 3] = c[3];
      }
    }
    // Upscale the coarse image smoothly.
    const tmp = document.createElement("canvas");
    tmp.width = cols;
    tmp.height = rows;
    tmp.getContext("2d").putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, cols * cell, rows * cell);
  },

  _vector(x, y) {
    const ll = this._map.containerPointToLatLng([x, y]);
    const u = this.sample("u", this.t, ll.lat, ll.lng);
    if (u == null) return null;
    return [u, this.sample("v", this.t, ll.lat, ll.lng)];
  },

  // Small, faint arrows on staggered rows pointing downwind; slightly longer and brighter in
  // stronger wind so high-wind areas still read at a glance.
  _drawArrows(size) {
    const ctx = this.overlay.getContext("2d");
    const spacing = 38;
    const rowStep = spacing * 0.87;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let row = 0;
    for (let y = rowStep / 2; y < size.y; y += rowStep, row++) {
      for (let x = (row % 2 ? spacing : spacing / 2); x < size.x; x += spacing) {
        const vec = this._vector(x, y);
        if (!vec) continue;
        const speed = Math.hypot(vec[0], vec[1]);
        if (speed < 2) continue;
        const k = Math.min(speed, 80) / 80;
        const len = 6 + 8 * k;
        const ang = Math.atan2(vec[1], vec[0]);
        const dx = Math.cos(ang);
        const dy = Math.sin(ang);
        const tx = x + (dx * len) / 2;
        const ty = y + (dy * len) / 2;
        const head = 2.5 + 1.5 * k;
        ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.4 * k})`;
        ctx.lineWidth = 1 + 0.6 * k;
        ctx.beginPath();
        ctx.moveTo(x - (dx * len) / 2, y - (dy * len) / 2);
        ctx.lineTo(tx, ty);
        ctx.moveTo(tx - head * Math.cos(ang - 0.55), ty - head * Math.sin(ang - 0.55));
        ctx.lineTo(tx, ty);
        ctx.lineTo(tx - head * Math.cos(ang + 0.55), ty - head * Math.sin(ang + 0.55));
        ctx.stroke();
      }
    }
  },

  // Gentle particle flow: roughly a quarter of the earlier speed, fewer and fainter streaks.
  _animate(size) {
    const count = Math.round(Math.min(1200, (size.x * size.y) / 1600));
    const spawn = () => ({ x: Math.random() * size.x, y: Math.random() * size.y, age: Math.floor(Math.random() * 150) });
    const particles = Array.from({ length: count }, spawn);
    const ctx = this.overlay.getContext("2d");
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    const step = () => {
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = "rgba(0,0,0,0.94)";
      ctx.fillRect(0, 0, size.x, size.y);
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      for (const p of particles) {
        const v = p.age < 160 ? this._vector(p.x, p.y) : null;
        if (!v) {
          Object.assign(p, spawn(), { age: 0 });
          continue;
        }
        const nx = p.x + v[0] * 0.012;
        const ny = p.y + v[1] * 0.012;
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(nx, ny);
        p.x = nx;
        p.y = ny;
        p.age++;
      }
      ctx.stroke();
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  },
});
