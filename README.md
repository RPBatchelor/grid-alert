# Victoria Event Intelligence

Full-screen operations map for preparing for and responding to major weather events in Victoria.
It overlays weather layers, distributor network boundaries and live outage data from all five
Victorian distribution networks, and generates callouts automatically.

## Run

```bash
npm install
npm run dev            # http://localhost:5173 — Vite with the /api proxy built in
# or, for a deployed instance:
npm run build && npm start   # http://localhost:8080 (PORT env var to change)
```

Node 22.13+ is required (outage history uses the built-in `node:sqlite`; Node prints a harmless "experimental" warning). The server part is needed because the trackers do not allow
cross-origin browser requests.

## Layout

- **Title block (top left).** Always shown in full, with the pin button for the sidebar.
- **Left sidebar (below the title).** By default it's a narrow icon rail. Clicking an icon opens it over the map
  with full labels, and the pin button keeps it open beside the map (remembered). It holds:
  - the pages, **Map** and **Trends**
  - **Map layers**: weather layer, base map, wind display, overlays and network filters
  - **Settings**
- **Right column (map page).** Two collapsible windows (state remembered):
  - **Automated intelligence**: alerts and warnings
  - **Network outages**: per-network outage summaries
- **Top bar.** The outage "last updated" banner, plus Live/Manual and Refresh.
- **Phones.** The right column becomes a scrolling bottom sheet.

## What's on the map

| Layer | Source | Notes |
|---|---|---|
| Wind / gusts / rain / temperature field, wind display (static arrows, slow animation, or hidden; shown on Wind/Gusts only), 48 h forecast slider with a red Now marker and a Now button to snap back | Open-Meteo forecast API on a ~0.65° grid over Victoria | Cached on the server for 30 min (stays within Open-Meteo's free 10k calls/day) |
| Windy base map (optional) | Windy Map Forecast API | Paste a key in **Settings** or set `VITE_WINDY_KEY`. A Windy *Premium* subscription does not include a Map Forecast API key. Get one at api.windy.com/keys and allow your domain. If the key fails, the app falls back to the built-in layers. |
| Rain radar (observed) | RainViewer public tiles | Latest past frame |
| Network boundaries | `public/data/network-boundaries.geojson` | **Approximate.** See below. |
| Outages | AusNet, Powercor, CitiPower, Jemena, United Energy trackers | See below |

### Outage feeds (`server/feeds.js`)

| Network | Endpoint used by the public tracker |
|---|---|
| AusNet | `outagetrackerservice.ausnetservices.com.au/api/v1/outages/combinedoutage` (+ `/stats`) |
| Powercor + CitiPower | `s3-ap-southeast-2.amazonaws.com/cppc-outage/outages.json` |
| Jemena | `poweroutages.jemena.com.au/data/all-outages.json` |
| United Energy | `ds5ykmduea4ri.cloudfront.net/outages-v2.json` |

Every feed is normalised to a single incident schema (id, network, planned/unplanned, location,
customers, status, cause, start, ETR, updated). Outage results are cached for 60 s (15 s on a
manual **Refresh**). If one tracker fails, its last good data is kept and flagged in the banner
and in the insights panel. CDN-hosted feeds are cache-busted the same way the trackers' own pages
do it. Without this, CloudFront serves copies that are hours old.

These are undocumented public endpoints behind the customer-facing maps. They can change without
notice, so production use should move to agreed data-sharing interfaces.

### Network boundaries

`npm run build:boundaries` regenerates the file. It joins the distributors' own "find your
distributor" suburb lookup to ABS ASGS 2021 Suburbs & Localities polygons, then dissolves them
per network. About 180 suburbs are served by more than one distributor; each of these is assigned
to one network by a nearest-neighbour vote. Specks and thin slivers are removed. The networks are then
simplified and smoothed as one shared-border topology, so neighbouring borders stay
identical. The deviation from the unsmoothed outline is typically under 100 m, with about
250 m at the 95th percentile; the script prints it. Tuning constants are at the top of
`scripts/build-boundaries.mjs`, and the fetched localities are cached in `data/.cache/`
(`-- --refetch` to refresh them). The lines are therefore indicative only. Replace them
with authoritative distributor GIS when it is available.

## Settings

Open Settings with the gear icon (top right). Changes apply immediately and are stored in the
browser.

- **General**: Light, Dark or Match system colour mode (panels, charts and base map), and which
  view opens by default.
- **Map layers**: base map (Auto, Light grey, Dark grey, Streets, Topographic, Satellite or
  OpenStreetMap, shown as preview cards; also selectable from the map's layer panel) and the
  base map to use while the weather layer is Off (default: Light grey). Then network colours, with a picker and a hex field per network plus reset. The
  defaults are AusNet `#ffcb08`, Powercor `#87be53`, CitiPower `#5ccfeb`, Jemena `#ba93fb` and
  UE `#84ffb7`, chosen by measurement against every map condition (see below) Also here: a boundary outline (a contrasting edge so very dark or light colours
  stay visible), boundary fill strength and weather layer opacity. Low-contrast choices are
  flagged next to the colour.
- **Data & refresh**: the Live refresh interval and the history stored so far.
- **Integrations**: the Windy API key.

## Network colour palette

The defaults were chosen by measuring candidate colours against every condition the lines are
drawn on: real Esri dark and light grey, streets, topographic and satellite tiles over
Victoria; the weather field at 62% over dark and light maps; and Windy's near-opaque overlay.

- No colour contrasts with all of those on its own, because the backgrounds run from
  near-black to near-white. Map lines therefore always get a **dark halo**, and the network
  colours are bright enough to read inside it, at about 2.8:1 or better on every background.
- Every pair is distinct for normal vision (OKLab ΔE ≥ 17) and for protan, deutan and tritan
  colour-blindness (ΔE ≥ 8).
- No network colour is near the red used for outage rings.
- AusNet keeps its brand yellow `#ffcb08`, the best-scoring colour in the brand palette.
- The Trends chart uses the same colours on the dark theme and the same hues 0.2 darker on the
  light theme, so they read on white. The stack order puts AusNet at the base and keeps CitiPower and Powercor
  together, with the best separation between neighbouring segments under those rules.

Custom colours chosen in Settings are kept. Settings flags any colour too dark to stand out
inside the halo.

## Outage history & Trends view

While the server runs it records every fresh outage fetch to SQLite at `data/history.sqlite`
(git-ignored). A background collector fetches every 5 minutes even when nobody has the app
open, and refreshes from the app are recorded too (at most one per 50 s).

- `snapshots` / `totals`: per network × planned/unplanned outage count and customers off supply
  at each fetch. A tracker that failed is stored as a gap, not as zero.
- `incidents`: register of every incident seen, with first and last seen times, peak and latest
  customers, location and cause.

The **Trends** tab (top bar, or `#trends` in the URL) charts this history:

- Range: 6 h, 24 h, 3 d, 7 d, 30 d or All.
- Measure: customers off supply or number of outages.
- Chart type, switched from the icons on the chart itself: stacked bar, stacked area, or line
  (not stacked, so each network can be read on its own values; planned outages are dashed).
- Filters: unplanned/planned (planned is hatched) and each network.

The page also shows headline tiles, an optional data table and an incident register. Each
interval shows the snapshot with the highest selected total, so short peaks are not averaged
away. History begins when the server first runs; the trackers offer no back-fill.

| Setting | Default | |
|---|---|---|
| `COLLECT_INTERVAL_MINUTES` | `5` | `0` disables the background collector |
| `HISTORY_DB` | `data/history.sqlite` | path to the SQLite file |

## Automated intelligence (`src/intel.js`)

- **Banner**: time of the last outage refresh. It turns amber if any tracker is unavailable; hover
  over it to see each feed's own timestamp.
- **Network panels**: unplanned outages and customers off supply, change since the last refresh,
  and the incident list (click an incident to zoom to it).
- **Outage clusters**: incidents grouped on screen, showing the outage count and customers off supply.
- **Strongest sampled wind** per network: the maximum modelled gust inside each service area at
  the selected forecast hour. Callout boxes are docked to the screen, not the map, so they stay
  readable at any zoom; leader lines follow the map point. Drag a box anywhere (positions are
  remembered), close one with ×, turn them all off with "Strongest-wind callout boxes", or restore
  everything with "Reset view & callouts".
- **Insight rules**: forecast gust peaks in the next 24 h (≥55/70/90 km/h), heavy rain
  (≥10 mm/h), outages in ≥50 km/h gusts (likely weather-related), new outages since the last
  refresh, incidents with 1,000+ customers off supply, and stale or failed feeds. Thresholds are in
  `THRESHOLDS` and are indicative. Tune them with operations.

**Live** mode re-polls every 1–10 min (set in **Settings**). **Manual** mode updates only when you
click Refresh.

## Limitations

This is decision support, not a source of truth. Forecast values are model output, not
observations or BoM warnings. Always confirm with network control systems and official warnings.
