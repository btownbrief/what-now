/* data.js — fetch layer for What Now
   All data comes live from the guide's public JSON endpoints.
   Cached in localStorage so repeat opens are instant.

   Every request has a hard timeout, so one stalled feed can never hold the
   whole app at "warming up". And every feed reports what it actually is —
   live, cached, stale, or absent — so the footer can tell the truth. */

const DATA_BASE = 'https://guide.btownbrief.com/data/';
const CACHE_PREFIX = 'wn_cache_';
const CACHE_TTL_MS = 10 * 60 * 1000;       // fresh enough to skip the network
const STALE_MAX_MS = 24 * 3600 * 1000;     // stale beats nothing — but not forever
const FETCH_TIMEOUT_MS = 8000;

const ENDPOINTS = {
  weather: 'weather/latest.json',
  beaches: 'weather/beaches.json',
  events: 'events/events.json',
  things: 'things.json',
  clubs: 'clubs.json',
  sunsetSpots: 'sunset-spots.json',
  hobbies: 'hobbies.json',
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

function withTimeout(ms) {
  // AbortSignal.timeout is 2022+; fall back to a manual controller
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), ms);
  return ctl.signal;
}

async function fetchJSON(path) {
  const res = await fetch(DATA_BASE + path, { cache: 'no-cache', signal: withTimeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(path + ' → ' + res.status);
  return res.json();
}

/* Returns { data, status }.
   data:   { weather, beaches, events, things, clubs, sunsetSpots, hobbies } —
           any may be null; the engine fails closed on whatever's missing.
   status: same keys → { state: 'live' | 'cache' | 'stale' | 'absent', ageMin }
           'live'   fetched from the network just now
           'cache'  local copy under 10 minutes old
           'stale'  fetch failed, serving an old copy (≤ 24h) and saying so
           'absent' nothing usable at all */
async function loadAll() {
  const keys = Object.keys(ENDPOINTS);
  const results = await Promise.allSettled(keys.map(async (key) => {
    const cached = cacheGet(key);
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < CACHE_TTL_MS) {
      return { data: cached.data, state: 'cache', ageMin: Math.round(age / 60000) };
    }
    try {
      const data = await fetchJSON(ENDPOINTS[key]);
      cacheSet(key, data);
      return { data, state: 'live', ageMin: 0 };
    } catch (err) {
      if (cached && age < STALE_MAX_MS) {
        return { data: cached.data, state: 'stale', ageMin: Math.round(age / 60000) };
      }
      throw err;
    }
  }));

  const data = {}, status = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      data[keys[i]] = r.value.data;
      status[keys[i]] = { state: r.value.state, ageMin: r.value.ageMin };
    } else {
      data[keys[i]] = null;
      status[keys[i]] = { state: 'absent', ageMin: null };
    }
  });
  return { data, status };
}

export { loadAll };
