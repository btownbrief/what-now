/* sunset-score.js — tonight's sunset, scored 0–10.
   A faithful port of the guide's sunset.js math: high clouds are the canvas,
   low clouds are the killer, and everything else nudges. Cloud layers come
   from Open-Meteo (keyless, client-side); rain chance and AQI come from the
   guide's weather JSON. If Open-Meteo is down we degrade to NWS total sky
   cover and say so. */

const OPEN_METEO_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=44.4759&longitude=-73.2121' +
  '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,relative_humidity_2m' +
  '&timezone=America%2FNew_York&forecast_days=2';

async function fetchCloudLayers() {
  try {
    const res = await fetch(OPEN_METEO_URL);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* Ramp to +2.5 at 30% canvas, hold through 55%, fade above. */
function canvasBonus(canvas) {
  if (canvas <= 30) return 2.5 * (canvas / 30);
  if (canvas <= 55) return 2.5;
  if (canvas <= 90) return 2.5 - 2.0 * ((canvas - 55) / 35);
  return 0.5;
}

/* sunset: Date · om: Open-Meteo payload or null · latest: guide weather JSON */
function computeSunsetScore(sunset, om, latest) {
  if (!sunset) return null;

  const hours = latest && latest.hourly && latest.hourly.hours || [];
  let popAtSunset = null;
  for (const h of hours) {
    if (Math.abs(new Date(h.t) - sunset) <= 90 * 60000) { popAtSunset = h.pop ?? null; break; }
  }
  const aqi = latest && latest.air ? latest.air.aqi : null;

  let score = 5.0;
  let degraded = false;

  const omHour = om ? nearestOmHour(om, sunset) : null;
  if (omHour) {
    const { low, mid, high, vis, rh } = omHour;
    const canvas = clamp(high + 0.6 * mid, 0, 100);
    score += canvasBonus(canvas);
    score += -7 * Math.pow(low / 100, 1.6);
    if (rh != null) score += -1.5 * clamp((rh - 65) / 25, 0, 1);
    if (vis != null) {
      if (vis >= 24000) score += 0.5;
      else if (vis < 10000) score += -2 * clamp((10000 - vis) / 10000, 0, 1);
    }
  } else {
    // Degraded: only NWS total sky cover to go on
    degraded = true;
    let sky = null, bestDiff = Infinity;
    for (const h of hours) {
      const diff = Math.abs(new Date(h.t) - sunset);
      if (diff < bestDiff) { bestDiff = diff; sky = h.sky ?? null; }
    }
    if (sky == null || bestDiff > 2 * 3600 * 1000) return null;
    score += clamp(1.5 - 7.5 * (sky / 100), -6, 1.5);
  }

  if (popAtSunset != null && popAtSunset > 5) score += -3 * (popAtSunset / 100);
  if (aqi != null) {
    if (aqi > 150) score += -3.5;
    else if (aqi > 100) score += -1.5;
    else if (aqi > 50) score += -0.5;
  }

  return { score: Math.round(clamp(score, 0, 10) * 10) / 10, degraded };
}

function nearestOmHour(om, when) {
  const h = om.hourly;
  if (!h || !h.time) return null;
  let idx = -1, bestDiff = Infinity;
  for (let i = 0; i < h.time.length; i++) {
    const diff = Math.abs(new Date(h.time[i]) - when);
    if (diff < bestDiff) { bestDiff = diff; idx = i; }
  }
  if (idx < 0 || bestDiff > 2 * 3600 * 1000) return null;
  return {
    low: h.cloud_cover_low ? h.cloud_cover_low[idx] ?? 0 : 0,
    mid: h.cloud_cover_mid ? h.cloud_cover_mid[idx] ?? 0 : 0,
    high: h.cloud_cover_high ? h.cloud_cover_high[idx] ?? 0 : 0,
    vis: h.visibility ? h.visibility[idx] : null,
    rh: h.relative_humidity_2m ? h.relative_humidity_2m[idx] : null,
  };
}

export { fetchCloudLayers, computeSunsetScore };
