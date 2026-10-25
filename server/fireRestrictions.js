// CFA Fire Danger Period (fire restriction) declarations by municipality, read from CFA's
// "Fire restriction dates" page. There is no feed, so the page's table is parsed:
//   Municipality | Start Date | End Date | Download Map
// Rows hold either dd/mm/yyyy dates or a status sentence ("No restrictions in force yet…",
// "Restrictions have ended for this fire season"). Some councils are split into parts
// ("ARARAT - NORTH"); each part is reported separately.
const PAGE = "https://www.cfa.vic.gov.au/warnings-and-restrictions/fire-danger-period/fire-restriction-dates";
const UA = "Mozilla/5.0 (GridAlertVic/0.2; +https://grid-alert.com; control-room situational awareness)";
const TZ = "Australia/Melbourne";

// CFA name -> Vicmap LGA name, where they differ.
const LGA_ALIASES = { "BOROUGH OF QUEENSCLIFFE": "QUEENSCLIFFE", "FRENCH ISLAND": "FRENCH-ELIZABETH-SANDSTONE ISLANDS" };

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// dd/mm/yyyy -> "yyyy-mm-dd" (a Melbourne calendar date).
function parseDate(s) {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

function todayMelbourne() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export function parseRestrictions(html, today = todayMelbourne()) {
  const table = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]).find((t) => /municipality/i.test(t));
  if (!table) throw new Error("CFA page has no municipality table (layout may have changed)");
  const rows = [];
  for (const [tr] of table.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...tr.matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t[hd]>/gi)];
    if (!cells.length || cells[0][1].toLowerCase() === "h") continue; // header row
    const area = text(cells[0][2]);
    if (!area) continue;
    const middle = cells.slice(1, -1).map((c) => text(c[2]));
    const mapHref = tr.match(/href=["']?([^"'\s>]+\.pdf[^"'\s>]*)/i)?.[1];
    const start = parseDate(middle[0] ?? "");
    const end = parseDate(middle[1] ?? "");
    const note = start ? null : middle.join(" ").trim();
    let status;
    if (start) {
      if (today < start) status = "upcoming";
      else if (end && today >= end) status = "ended";
      else status = "declared";
    } else if (/ended/i.test(note ?? "")) status = "ended";
    else status = "not-declared";
    const [council, part] = area.split(/\s+-\s+/);
    rows.push({
      area,
      council,
      part: part ?? null,
      lga: LGA_ALIASES[council] ?? council,
      status,
      start,
      end,
      startsInDays: start && status === "upcoming" ? daysBetween(today, start) : null,
      note,
      // e.g. a start date typed with the wrong year: show it, but flag it rather than guess.
      anomaly: start && end && start > end ? "CFA lists a start date after the end date — check the CFA page" : null,
      map: mapHref ? new URL(mapHref, "https://www.cfa.vic.gov.au").href : null,
    });
  }
  if (!rows.length) throw new Error("CFA restriction table was empty");
  return rows;
}

let cache = null;
export async function getFireRestrictions({ maxAgeMs = 60 * 60000 } = {}) {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.body;
  try {
    const res = await fetch(PAGE, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`CFA page HTTP ${res.status}`);
    const rows = parseRestrictions(await res.text());
    const count = (s) => rows.filter((r) => r.status === s).length;
    const body = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      today: todayMelbourne(),
      source: PAGE,
      summary: { declared: count("declared"), upcoming: count("upcoming"), ended: count("ended"), notDeclared: count("not-declared"), total: rows.length },
      rows,
    };
    cache = { at: Date.now(), body };
    return body;
  } catch (error) {
    if (cache) return { ...cache.body, ok: false, stale: true, error: error.message };
    throw error;
  }
}
