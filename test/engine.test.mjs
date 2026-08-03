/* engine.test.mjs — the edge cases from the 2026-08-02 adversarial review
   (what-now#1), pinned as tests so they stay fixed.

   Run:  TZ=UTC node --test test/engine.test.mjs
   The UTC TZ is deliberate: everything time-shaped must come out in
   America/New_York no matter what the device thinks. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, buildPool, fmtTime, outdoorRisks, clubMatchesToday } from '../js/engine.js';

/* ---------- fixtures ---------- */
/* Tue Aug 4 2026, Burlington (EDT, UTC-4). Sunrise 5:43, sunset 20:14. */

const NY = (h, m = 0, day = 4) =>
  new Date(`2026-08-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`);

function goodWeather(now, overrides = {}) {
  return {
    updated: new Date(now - 10 * 60000).toISOString(),
    now: {
      temp_f: 78, feels_like_f: 78, description: 'Mostly Sunny',
      wind_mph: 5, wind_gust_mph: null,
      ...(overrides.now || {}),
    },
    sun: {
      sunrise: '2026-08-04T05:43-04:00',
      sunset: '2026-08-04T20:14-04:00',
      ...(overrides.sun || {}),
    },
    hourly: { hours: [] },
    alerts: { active: overrides.alerts || [] },
    air: { aqi: overrides.aqi ?? 30 },
    lake_gage: overrides.lake_gage !== undefined ? overrides.lake_gage : {
      water_temp_f: 74,
      water_temp_at: new Date(now - 3600 * 1000).toISOString(),
    },
  };
}

function goodBeaches(now) {
  return {
    beaches: [
      { name: 'North Beach', status: 'green', ecoli: null, sampled: fmtSample(new Date(now - 2 * 86400000)) },
    ],
  };
}

function fmtSample(d) {
  // the city feed's format: "08/02/2026 2:54 PM"
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} 2:00 PM`;
}

const OUTDOOR_THING = {
  id: 'walk', name: 'Waterfront walk', neighborhood: 'Waterfront',
  cost_tier: 'Free', indoor_outdoor: 'Outdoor',
  season: ['Year-Round'], time_of_day: [], good_for: [], vibe: [],
};
const INDOOR_THING = {
  id: 'museum', name: 'A museum', neighborhood: 'Downtown',
  cost_tier: '$', indoor_outdoor: 'Indoor',
  season: ['Year-Round'], time_of_day: [], good_for: [], vibe: [],
};

function evt(id, start, end, extra = {}) {
  return {
    id, title: 'Event ' + id, date: '2026-08-04',
    start, end, venue: 'Somewhere', town: 'Burlington',
    free: true, indoorOutdoor: 'indoor', category: 'music', tags: [],
    ...extra,
  };
}

const pool = (data, now, chips = new Set()) => buildPool(data, buildContext(data, now), chips);
const ids = (p) => p.map((c) => c.id);

/* ---------- blocker 1: time ---------- */

test('2am is Late Night, not Morning', () => {
  const ctx = buildContext({}, NY(2));
  assert.equal(ctx.block, 'Late Night');
  assert.equal(ctx.hour, 2);
});

test('daypart boundaries land where the UI says they do', () => {
  assert.equal(buildContext({}, NY(5)).block, 'Morning');
  assert.equal(buildContext({}, NY(11)).block, 'Afternoon');
  assert.equal(buildContext({}, NY(17)).block, 'Evening');
  assert.equal(buildContext({}, NY(22)).block, 'Late Night');
});

test('Burlington time wins over device time (suite runs under TZ=UTC)', () => {
  // 2026-08-05T01:30Z is still Aug 4, 9:30pm in Burlington
  const ctx = buildContext({}, new Date('2026-08-05T01:30:00Z'));
  assert.equal(ctx.dateStr, '2026-08-04');
  assert.equal(ctx.hour, 21);
  assert.equal(fmtTime(new Date('2026-08-05T01:30:00Z')), '9:30pm');
});

test('an 8am event is not an answer at 2am', () => {
  const data = { events: { events: [evt('a', '2026-08-04T08:00:00-04:00', '2026-08-04T10:00:00-04:00')] } };
  assert.deepEqual(ids(pool(data, NY(2))), []);
});

test('an event ~2.5h out still qualifies', () => {
  const data = { events: { events: [evt('a', '2026-08-04T16:30:00-04:00', '2026-08-04T18:00:00-04:00')] } };
  assert.deepEqual(ids(pool(data, NY(14))), ['evt-a']);
});

test('unparseable event times are dropped, not crashed on', () => {
  const data = { events: { events: [evt('bad', 'not a date', null)] } };
  assert.deepEqual(ids(pool(data, NY(14))), []);
});

test('clubs sit out the small hours', () => {
  const data = { clubs: { clubs: [{ name: 'Chess Club', what: 'Chess', when: 'Daily' }] } };
  assert.deepEqual(ids(pool(data, NY(2))), []);
  assert.equal(pool(data, NY(23)).length, 0);
  assert.equal(pool(data, NY(14)).length, 1);
});

test('day-specific clubs only show on their day', () => {
  // Aug 4 2026 is a Tuesday
  const data = { clubs: { clubs: [
    { name: 'Sat Runs', what: 'Running', when: 'Saturdays 9am' },
    { name: 'Tue Chess', what: 'Chess', when: 'Tuesdays 7pm' },
  ] } };
  assert.deepEqual(ids(pool(data, NY(14))), ['club-tue-chess']);
});

test('clubMatchesToday: generic schedules pass, named days gate', () => {
  assert.equal(clubMatchesToday('Several events most weeks', 2), true);
  assert.equal(clubMatchesToday('Varies — check the calendar', 2), true);
  assert.equal(clubMatchesToday('Saturdays 10am', 2), false);
  assert.equal(clubMatchesToday('Saturdays 10am', 6), true);
  assert.equal(clubMatchesToday('Mon & Wed evenings', 3), true);
  assert.equal(clubMatchesToday('', 2), true);
});

test('clubs are only "free" when they say so', () => {
  const data = { clubs: { clubs: [
    { name: 'Free Club', what: 'Open and free to all', when: 'Daily' },
    { name: 'Dues Club', what: 'Annual dues apply', when: 'Daily' },
  ] } };
  const p = pool(data, NY(14), new Set(['free']));
  assert.deepEqual(ids(p), ['club-free-club']);
});

/* ---------- blocker 2: outdoor safety ---------- */

test('dangerous cold keeps everything strictly-outdoor out of the pool', () => {
  const now = NY(14);
  const data = {
    weather: goodWeather(now, { now: { temp_f: 5, feels_like_f: -8, description: 'Clear' } }),
    things: [OUTDOOR_THING, INDOOR_THING],
  };
  assert.deepEqual(ids(pool(data, now)), ['thing-museum']);
});

test('an active weather alert does the same', () => {
  const now = NY(14);
  const data = {
    weather: goodWeather(now, { alerts: [{ event: 'Extreme Cold Warning' }] }),
    things: [OUTDOOR_THING, INDOOR_THING],
  };
  assert.deepEqual(ids(pool(data, now)), ['thing-museum']);
});

test('high wind and unhealthy air each gate outdoor answers', () => {
  const now = NY(14);
  for (const overrides of [{ now: { wind_mph: 35 } }, { aqi: 180 }]) {
    const data = { weather: goodWeather(now, overrides), things: [OUTDOOR_THING, INDOOR_THING] };
    assert.deepEqual(ids(pool(data, now)), ['thing-museum']);
  }
});

test('no weather read at all = nobody gets sent outside', () => {
  const now = NY(14);
  const data = { things: [OUTDOOR_THING, INDOOR_THING] };
  assert.ok(outdoorRisks(buildContext(data, now)).length > 0);
  assert.deepEqual(ids(pool(data, now)), ['thing-museum']);
});

test('a 3h-stale weather feed counts as no weather', () => {
  const now = NY(14);
  const w = goodWeather(now);
  w.updated = new Date(now - 5 * 3600 * 1000).toISOString();
  const ctx = buildContext({ weather: w }, now);
  assert.equal(ctx.temp, null);
  assert.ok(outdoorRisks(ctx).length > 0);
});

test('rain right now drops outdoor-only spots', () => {
  const now = NY(14);
  const data = {
    weather: goodWeather(now, { now: { description: 'Light Rain' } }),
    things: [OUTDOOR_THING, INDOOR_THING],
  };
  assert.deepEqual(ids(pool(data, now)), ['thing-museum']);
});

test('after dark, outdoor-only spots need to be meant for the dark', () => {
  const now = NY(23);
  const data = {
    weather: goodWeather(now),
    things: [
      OUTDOOR_THING, // no time_of_day → not a night activity
      { ...OUTDOOR_THING, id: 'stars', name: 'Stargazing', time_of_day: ['Late Night'] },
    ],
  };
  assert.deepEqual(ids(pool(data, now)), ['thing-stars']);
});

/* ---------- blocker 3: the swim ---------- */

const swimDay = (now, over = {}) => ({
  weather: goodWeather(now, { now: { temp_f: 84, feels_like_f: 84, description: 'Sunny' }, ...over }),
  beaches: goodBeaches(now),
});

test('a perfect summer afternoon produces a swim with real numbers', () => {
  const now = NY(14);
  const p = pool(swimDay(now), now);
  const beach = p.find((c) => c.kind === 'beach');
  assert.ok(beach, 'expected a swim candidate');
  assert.match(beach.why_.join(' '), /84° and the lake's 74°/);
  assert.doesNotMatch(beach.why_.join(' '), /null/);
});

test('no lake temperature = no swim (never "the lake\'s null°")', () => {
  const now = NY(14);
  const data = swimDay(now, { lake_gage: null });
  assert.equal(pool(data, now).find((c) => c.kind === 'beach'), undefined);
});

test('a day-old lake reading is fine; a three-day-old one is not', () => {
  const now = NY(14);
  const stale = swimDay(now, {
    lake_gage: { water_temp_f: 74, water_temp_at: new Date(now - 3 * 86400000).toISOString() },
  });
  assert.equal(pool(stale, now).find((c) => c.kind === 'beach'), undefined);
});

test('no swim at 11pm, and no swim when sunset is unknown', () => {
  const lateNow = NY(23);
  assert.equal(pool(swimDay(lateNow), lateNow).find((c) => c.kind === 'beach'), undefined);

  const now = NY(14);
  const noSun = swimDay(now, { sun: { sunrise: null, sunset: null } });
  assert.equal(pool(noSun, now).find((c) => c.kind === 'beach'), undefined);
});

test('a month-old "clean" test does not count', () => {
  const now = NY(14);
  const data = swimDay(now);
  data.beaches.beaches[0].sampled = fmtSample(new Date(now - 30 * 86400000));
  assert.equal(pool(data, now).find((c) => c.kind === 'beach'), undefined);
});

test('no swim outside swim season, however warm', () => {
  // a freak 84° mid-October Tuesday (Oct 13 2026)
  const now = new Date('2026-10-13T14:00:00-04:00');
  const data = {
    weather: goodWeather(now, {
      now: { temp_f: 84, feels_like_f: 84, description: 'Sunny' },
      sun: { sunrise: '2026-10-13T07:07-04:00', sunset: '2026-10-13T18:11-04:00' },
    }),
    beaches: goodBeaches(now),
  };
  assert.equal(pool(data, now).find((c) => c.kind === 'beach'), undefined);
});

/* ---------- blocker 4: absent feeds ---------- */

test('malformed feeds: garbage timestamps and wrong types never crash or leak outdoors', () => {
  const now = NY(14);
  const evil = {
    weather: {
      updated: 'garbage', now: { temp_f: 'hot' }, sun: { sunset: 'nope' },
      hourly: { hours: [{ t: 'x' }] }, alerts: {},
      lake_gage: { water_temp_f: 74, water_temp_at: 'bad' },
    },
    beaches: { beaches: [{ name: 'North Beach', status: 'green', sampled: 'not a date' }] },
    events: { events: [evt('x', '2026-08-04T15:00:00-04:00', null, { indoorOutdoor: 'outdoor' })] },
    things: [OUTDOOR_THING, INDOOR_THING],
    clubs: { clubs: [{ name: 'C', what: 'x', when: 42 }, { name: null }, null] },
  };
  const ctx = buildContext(evil, now);
  assert.equal(ctx.temp, null);       // unparseable 'updated' = stale = no weather
  assert.equal(ctx.lakeTemp, null);   // unparseable gage timestamp = no reading
  assert.equal(ctx.openBeaches.length, 0); // unparseable sample = not verified
  const p = buildPool(evil, ctx, new Set());
  assert.ok(p.every((c) => !isNaN(c.score_)), 'scores stay numeric');
  assert.ok(!p.some((c) => c.outdoor), 'no weather read = nobody outdoors');
});

test('all feeds null: context builds, pool is empty, nothing throws', () => {
  const now = NY(14);
  const ctx = buildContext({ weather: null, beaches: null, events: null, things: null, clubs: null, sunsetSpots: null }, now);
  assert.equal(ctx.temp, null);
  assert.equal(ctx.lakeTemp, null);
  assert.deepEqual(buildPool({}, ctx, new Set()), []);
});

/* ---------- blocker 5: pure chance still obeys the ground rules ---------- */

test('the unfiltered pool never contains unsafe candidates for wildcard to find', () => {
  const now = NY(14);
  const data = {
    weather: goodWeather(now, { now: { temp_f: 2, feels_like_f: -12, description: 'Clear' } }),
    things: [OUTDOOR_THING, INDOOR_THING],
    events: { events: [evt('out', '2026-08-04T15:00:00-04:00', '2026-08-04T17:00:00-04:00', { indoorOutdoor: 'outdoor' })] },
  };
  // empty chip set = what wildcard uses; outdoor stuff must already be gone
  const p = pool(data, now, new Set());
  assert.ok(p.every((c) => !(c.kind === 'thing' && c.strictlyOutdoor)));
  assert.ok(p.every((c) => !(c.kind === 'event' && c.outdoor)));
});

test('outdoor event in rain survives with a caution flag (wildcard filters those)', () => {
  const now = NY(14);
  const data = {
    weather: goodWeather(now, { now: { description: 'Rain Showers' } }),
    events: { events: [evt('out', '2026-08-04T15:00:00-04:00', '2026-08-04T17:00:00-04:00', { indoorOutdoor: 'outdoor' })] },
  };
  const p = pool(data, now, new Set());
  const e = p.find((c) => c.id === 'evt-out');
  assert.ok(e, 'organized outdoor events may stay in the ranked pool during rain');
  assert.equal(e.caution, true);
});
