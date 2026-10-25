// CFA Fire Danger Ratings and Total Fire Bans by fire district, from CFA's public forecast RSS
// (today + the next few days). Each RSS item is one day; its description lists every district's
// Total Fire Ban status and Fire Danger Rating.
const FEED = "https://www.cfa.vic.gov.au/cfa/rssfeed/tfbfdrforecast_rss.xml";
const UA = "Mozilla/5.0 (GridAlertVic/0.2; +https://grid-alert.com; control-room situational awareness)";
const RATINGS = ["NO RATING", "MODERATE", "HIGH", "EXTREME", "CATASTROPHIC"];

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

// "District: VALUE" lines from an HTML paragraph.
function lines(html) {
  return html
    .split(/<br\s*\/?>/i)
    .map((l) => l.replace(/<[^>]+>/g, "").trim())
    .map((l) => l.match(/^(.+?):\s*(.+)$/))
    .filter(Boolean)
    .map(([, k, v]) => [k.trim(), v.trim()]);
}

export function parseFireDanger(xml) {
  const days = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const titleText = decode(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").trim();
    const html = decode(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
    const paragraphs = [...html.matchAll(/<p>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
    const summary = (paragraphs[0] ?? "").replace(/<[^>]+>/g, "").trim();
    const issued = html.match(/forecast issued at:\s*([^<]+)/i)?.[1]?.trim() ?? null;
    const districts = {};
    for (const p of paragraphs) {
      for (const [name, value] of lines(p)) {
        if (/issued|forecast/i.test(name)) continue;
        const v = value.toUpperCase();
        const d = (districts[name] ??= { tfb: null, tfbText: null, rating: null });
        // Ratings first: "NO RATING" must not be read as a "NO" Total Fire Ban status.
        if (RATINGS.includes(v)) {
          d.rating = v;
        } else if (/^(YES|NO)\b/.test(v)) {
          d.tfb = v.startsWith("YES");
          d.tfbText = value;
        }
      }
    }
    const date = new Date(`${titleText} 12:00`);
    days.push({
      title: titleText,
      date: Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10),
      summary,
      issued,
      anyTfb: Object.values(districts).some((d) => d.tfb),
      districts,
    });
  }
  if (!days.length) throw new Error("CFA feed contained no forecast days");
  return days;
}

let cache = null;
export async function getFireDanger({ maxAgeMs = 15 * 60000 } = {}) {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.body;
  try {
    const res = await fetch(`${FEED}?v=${Date.now()}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`CFA feed HTTP ${res.status}`);
    const xml = await res.text();
    const published = xml.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
    const body = { ok: true, fetchedAt: new Date().toISOString(), published: published ? new Date(published).toISOString() : null, source: FEED, days: parseFireDanger(xml) };
    cache = { at: Date.now(), body };
    return body;
  } catch (error) {
    // Keep serving the last good copy, flagged as stale.
    if (cache) return { ...cache.body, ok: false, stale: true, error: error.message };
    throw error;
  }
}
