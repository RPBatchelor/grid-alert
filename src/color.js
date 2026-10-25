// Small colour utilities (sRGB <-> OKLCH, WCAG contrast).

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

export function hexToOklch(hex) {
  const [r, g, b] = channels(hex).map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

// Converts back to hex, reducing chroma until the colour fits in sRGB.
export function oklchToHex(L, C, H) {
  for (let c = C; c >= 0; c -= 0.004) {
    const A = c * Math.cos(H);
    const B = c * Math.sin(H);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    if (rgb.every((v) => v >= 0 && v <= 1)) return `#${rgb.map((v) => Math.round(fromLin(v) * 255).toString(16).padStart(2, "0")).join("")}`;
  }
  return "#808080";
}

// Same hue, lightness shifted by dL (keeping a minimum chroma so it doesn't turn grey).
export function shade(hex, dL) {
  const [L, C, H] = hexToOklch(hex);
  return oklchToHex(Math.min(0.98, Math.max(0.05, L + dL)), Math.max(C, 0.12), H);
}

function luminance(hex) {
  const [r, g, b] = channels(hex).map(toLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
