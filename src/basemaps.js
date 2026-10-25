// Base maps (all keyless). `tone` drives overlay contrast (boundary casing, ring labels),
// independent of the UI's light/dark mode. `reference` is an optional labels layer drawn
// above the weather field.
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const ESRI_ATTR = "Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors";

export const BASEMAPS = {
  "light-gray": {
    name: "Light grey",
    tone: "light",
    base: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    reference: `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
    maxNativeZoom: 16,
    attribution: ESRI_ATTR,
  },
  "dark-gray": {
    name: "Dark grey",
    tone: "dark",
    base: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    reference: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
    maxNativeZoom: 16,
    attribution: ESRI_ATTR,
  },
  streets: {
    name: "Streets",
    tone: "light",
    base: `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`,
    maxNativeZoom: 19,
    attribution: `${ESRI_ATTR}, USGS`,
  },
  topo: {
    name: "Topographic",
    tone: "light",
    base: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`,
    maxNativeZoom: 19,
    attribution: `${ESRI_ATTR}, USGS, NOAA`,
  },
  imagery: {
    name: "Satellite",
    tone: "dark",
    base: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    reference: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
    maxNativeZoom: 19,
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
  },
  osm: {
    name: "OpenStreetMap",
    tone: "light",
    base: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxNativeZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
};

// A z6 tile over Victoria, used as a thumbnail in Settings.
export function previewUrl(key) {
  return BASEMAPS[key].base.replace("{z}", "6").replace("{x}", "57").replace("{y}", "39");
}
