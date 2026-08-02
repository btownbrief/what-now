/* data.js — fetch layer for What Now
   All data comes live from the guide's public JSON endpoints.
   Cached in localStorage (stale-while-revalidate) so repeat opens are instant. */

const DATA_BASE = 'https://guide.btownbrief.com/data/';
const CACHE_PREFIX = 'wn_cache_';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const ENDPOINTS = {
  weather: 'weather/latest.json',
  beaches: 'weather/beaches.json',
  events: 'events/events.json',
  things: 'things.json',
  clubs: 'clubs.json',
  sunsetSpots: 'sunset-spots.json',
  ticker: 'ticker.json',
};

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data }));
  } catch { /* storage full or private mode — fine, we just refetch */ }
}

async function fetchJSON(path) {
  const res = await fetch(DATA_BASE + path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(path + ' → ' + res.status);
  return res.json();
}

/* Returns { weather, beaches, events, things, clubs, sunsetSpots, ticker }.
   Any endpoint may be null if it failed and no cache exists — the engine
   degrades gracefully. */
async function loadAll() {
  const keys = Object.keys(ENDPOINTS);
  const results = await Promise.allSettled(keys.map(async (key) => {
    const cached = cacheGet(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { key, data: cached.data };
    }
    try {
      const data = await fetchJSON(ENDPOINTS[key]);
      cacheSet(key, data);
      return { key, data };
    } catch (err) {
      if (cached) return { key, data: cached.data }; // stale beats nothing
      throw err;
    }
  }));

  const out = {};
  results.forEach((r, i) => {
    out[keys[i]] = r.status === 'fulfilled' ? r.value.data : null;
  });
  return out;
}

export { loadAll };
