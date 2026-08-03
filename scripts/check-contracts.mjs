/* check-contracts.mjs — proves the deployed guide feeds still carry every
   field this app consumes. A renamed root or field would silently empty
   part of the candidate pool; this turns that into a loud CI failure.

   Run:  node scripts/check-contracts.mjs
   Exits non-zero on any missing field or unreachable feed. */

const BASE = 'https://guide.btownbrief.com/data/';

/* path syntax: dots descend; [] samples every element of an array (a field
   counts as present if ANY sampled element carries it — feeds are allowed
   sparse optionals like event coords). */
const CONTRACTS = {
  'weather/latest.json': [
    'updated',
    'now.temp_f', 'now.feels_like_f', 'now.description', 'now.wind_mph',
    'sun.sunrise', 'sun.sunset', 'sun.sunset_tomorrow',
    'hourly.hours[].t', 'hourly.hours[].pop', 'hourly.hours[].sky', 'hourly.hours[].temp_f',
    'alerts.active',
    'air.aqi',
    'lake_gage.water_temp_f', 'lake_gage.water_temp_at',
    'forecast.periods[].name', 'forecast.periods[].start', 'forecast.periods[].is_day',
    'forecast.periods[].temp_f', 'forecast.periods[].pop', 'forecast.periods[].short',
  ],
  'weather/beaches.json': [
    'beaches[].name', 'beaches[].status', 'beaches[].sampled',
  ],
  'events/events.json': [
    'generated',
    'events[].id', 'events[].title', 'events[].date', 'events[].start',
    'events[].venue', 'events[].free', 'events[].category', 'events[].lat',
  ],
  'things.json': [
    '[].id', '[].name', '[].season', '[].time_of_day', '[].indoor_outdoor',
    '[].cost_tier', '[].good_for', '[].neighborhood', '[].coords', '[].category',
  ],
  'clubs.json': [
    'clubs[].name', 'clubs[].what', 'clubs[].when',
  ],
  'sunset-spots.json': [
    'spots[].name', 'spots[].area', 'spots[].walk_min',
  ],
  'hobbies.json': [
    'hobbies[].id', 'hobbies[].name', 'hobbies[].months', 'hobbies[].what', 'hobbies[].start',
  ],
};

function present(node, path) {
  const [head, ...rest] = path;
  if (head === undefined) return true;
  if (head === '[]') {
    if (!Array.isArray(node) || !node.length) return false;
    return node.slice(0, 50).some((el) => el != null && present(el, rest));
  }
  if (node == null || typeof node !== 'object' || !(head in node)) return false;
  return present(node[head], rest);
}

let failures = 0;
for (const [file, paths] of Object.entries(CONTRACTS)) {
  let body;
  try {
    const res = await fetch(BASE + file, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    body = await res.json();
  } catch (err) {
    console.error(`✗ ${file}: unreachable (${err.message})`);
    failures += paths.length;
    continue;
  }
  for (const p of paths) {
    const parts = p.replace(/\[\]/g, '.[].').split('.').filter(Boolean);
    if (present(body, parts)) {
      console.log(`✓ ${file} :: ${p}`);
    } else {
      console.error(`✗ ${file} :: ${p} — MISSING`);
      failures += 1;
    }
  }
}

if (failures) {
  console.error(`\n${failures} contract check(s) failed.`);
  process.exit(1);
}
console.log('\nAll contracts hold.');
