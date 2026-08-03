/* engine.js — turns live Burlington data + the current moment into ONE answer.

   Candidate sources:
     - today's real events (guide events pipeline, ~25 sources)
     - evergreen "things to do" (215 curated places/activities)
     - clubs & recurring meetups (for the "people" path)
     - tonight's sunset plan (score + spot + arrival time)
     - a swim (lake temp + beach status, when it's hot)

   Each candidate gets a context score; the spinner picks weighted-random
   from the top of the pile so respins feel alive but never feel dumb.

   House rule since the adversarial review: the pool only ever contains
   answers that are safe and sensible RIGHT NOW. Safety and timing are
   enforced when the pool is built, not by chips — so nothing downstream
   (including pure chance) can reach around them. */

/* ---------- Burlington time ---------- */
/* Everything about "today" and "what hour is it" is computed in
   America/New_York, not device time — a visitor's phone on Chicago time
   should still get Burlington's evening. */

const TZ = 'America/New_York';

const NY_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour12: false, weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const NY_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
});
const WEEKDAY_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function nyParts(d) {
  const o = {};
  for (const p of NY_PARTS_FMT.formatToParts(d)) o[p.type] = p.value;
  return {
    year: +o.year, month: +o.month, day: +o.day,
    hour: +o.hour % 24, minute: +o.minute,
    weekday: WEEKDAY_IDX[o.weekday] ?? new Date(d).getDay(),
  };
}

function fmtTime(d) {
  return NY_TIME_FMT.format(d).toLowerCase().replace(/\s/g, '').replace(':00', '');
}

/* ---------- context ---------- */

/* How old live readings can be before we stop trusting them. */
const WEATHER_MAX_AGE_MIN = 180;      // a 3h-old "now" is not now
const LAKE_TEMP_MAX_AGE_H = 24;       // USGS gage updates hourly
const BEACH_SAMPLE_MAX_AGE_DAYS = 8;  // city samples Mon + Thu

function buildContext(data, now = new Date()) {
  const w = data.weather || {};
  const sun = w.sun || {};
  const hours = (w.hourly && w.hourly.hours) || [];

  // A stale weather feed is treated as no weather at all — every consumer
  // of these fields fails closed rather than acting on an old sky.
  const weatherAt = w.updated ? new Date(w.updated) : null;
  const weatherAgeMin = weatherAt && !isNaN(weatherAt) ? (now - weatherAt) / 60000 : null;
  const weatherFresh = weatherAgeMin != null && weatherAgeMin >= 0 && weatherAgeMin <= WEATHER_MAX_AGE_MIN;
  const nowW = weatherFresh ? (w.now || {}) : {};

  const sunset = sun.sunset ? new Date(sun.sunset) : null;
  const sunrise = sun.sunrise ? new Date(sun.sunrise) : null;
  const minsToSunset = sunset && !isNaN(sunset) ? Math.round((sunset - now) / 60000) : null;

  // precip probability + sky cover over the next ~3 hours
  const soon = hours.filter(h => {
    const t = new Date(h.t);
    return t >= now && t - now < 3 * 3600 * 1000;
  });
  const popSoon = soon.length ? Math.max(...soon.map(h => h.pop ?? 0)) : null;

  // sky cover at the sunset hour (for the sunset score)
  let skyAtSunset = null;
  if (sunset) {
    let best = null, bestDiff = Infinity;
    for (const h of hours) {
      const diff = Math.abs(new Date(h.t) - sunset);
      if (diff < bestDiff) { bestDiff = diff; best = h; }
    }
    if (best && bestDiff < 2 * 3600 * 1000) skyAtSunset = best.sky ?? null;
  }

  const p = nyParts(now);
  const hour = p.hour;
  const block =
    hour < 5 ? 'Late Night'
    : hour < 11 ? 'Morning'
    : hour < 17 ? 'Afternoon'
    : hour < 22 ? 'Evening'
    : 'Late Night';

  // Dark = more than ~30 min outside the sun's day. With no sun data,
  // assume Burlington hours: dark before 6am and after 9pm.
  let dark;
  if (sunrise && sunset && !isNaN(sunrise) && !isNaN(sunset)) {
    dark = now < sunrise - 30 * 60000 || now > +sunset + 30 * 60000;
  } else {
    dark = hour < 6 || hour >= 21;
  }

  // Lake temp only counts when the gage reading is recent.
  let lakeTemp = null;
  if (w.lake_gage && w.lake_gage.water_temp_f != null && w.lake_gage.water_temp_at) {
    const at = new Date(w.lake_gage.water_temp_at);
    if (!isNaN(at) && (now - at) / 3600000 <= LAKE_TEMP_MAX_AGE_H) lakeTemp = w.lake_gage.water_temp_f;
  }

  // A beach is swimmable only if it's green AND the sample is recent —
  // a month-old "clean" says nothing about today's water.
  const beaches = (data.beaches && data.beaches.beaches) || [];
  const openBeaches = beaches.filter(b => {
    if (b.status !== 'green' || !b.sampled) return false;
    const at = new Date(b.sampled);
    return !isNaN(at) && (now - at) / 86400000 <= BEACH_SAMPLE_MAX_AGE_DAYS;
  });

  return {
    now,
    hour,
    block,
    weekday: p.weekday,
    isWeekend: [0, 6].includes(p.weekday),
    dateStr: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
    month: p.month,
    dark,
    weatherFresh,
    temp: nowW.temp_f ?? null,
    feels: nowW.feels_like_f ?? null,
    desc: (nowW.description || '').toLowerCase(),
    wind: nowW.wind_mph ?? null,
    gust: nowW.wind_gust_mph ?? null,
    popSoon,
    skyAtSunset,
    rainingNow: /rain|shower|drizzle|storm/.test((nowW.description || '').toLowerCase()),
    sunset,
    minsToSunset,
    lakeTemp,
    openBeaches,
    aqi: weatherFresh && w.air ? w.air.aqi : null,
    alerts: (weatherFresh && w.alerts && w.alerts.active) || [],
    sunsetScore: null, // filled by the caller (needs an extra async fetch)
  };
}

/* ---------- outdoor safety ---------- */

/* Reasons it is NOT okay to send someone outside on purpose right now.
   Missing weather counts: if we can't read the sky, we don't clear anyone
   to go stand under it. */
function outdoorRisks(ctx) {
  const risks = [];
  if (ctx.temp == null) { risks.push('no current weather read'); return risks; }
  const feels = ctx.feels ?? ctx.temp;
  if (feels <= 15) risks.push('dangerous cold');
  if (feels >= 100) risks.push('dangerous heat');
  if ((ctx.wind ?? 0) >= 30 || (ctx.gust ?? 0) >= 45) risks.push('high wind');
  if ((ctx.aqi ?? 0) > 150) risks.push('unhealthy air');
  if (ctx.alerts.length) risks.push('active weather alert');
  return risks;
}

function isStrictlyOutdoor(c) {
  if (c.kind === 'sunset' || c.kind === 'beach') return true;
  if (c.kind === 'event') return c.outdoor;
  if (c.kind === 'thing') return c.strictlyOutdoor;
  return false;
}

/* ---------- constraint chips ---------- */
/* keys: 'free' | 'outside' | 'people' | 'twohours' */

const EVENT_PEOPLE_CATS = new Set([
  'music', 'community', 'market', 'food-drink', 'comedy', 'games', 'sports', 'family',
]);

/* ---------- candidate builders ---------- */

const EVENT_MAX_LEAD_MIN = 180; // "now" means within ~3 hours, not tonight-at-8-from-2am

function eventCandidates(data, ctx) {
  const events = (data.events && data.events.events) || [];
  const out = [];
  for (const e of events) {
    if (e.status && e.status !== 'active') continue;
    if (e.date !== ctx.dateStr) continue;
    const start = e.start ? new Date(e.start) : null;
    const end = e.end ? new Date(e.end) : null;
    if (!start || isNaN(start)) continue;
    if (end && isNaN(end)) continue;
    const minsToStart = Math.round((start - ctx.now) / 60000);
    const minsSinceStart = -minsToStart;
    const durMin = end ? Math.round((end - start) / 60000) : null;
    // skip if it's over, or ends within 30 min
    if (end && (end - ctx.now) / 60000 < 30) continue;
    // skip if it started > 45 min ago and we don't know it runs long
    if (minsSinceStart > 45 && !(durMin && durMin >= 180)) continue;
    // skip things that start too far away to be an answer to "now"
    if (minsToStart > EVENT_MAX_LEAD_MIN) continue;

    out.push({
      kind: 'event',
      id: 'evt-' + e.id,
      title: e.title,
      venue: e.venue || e.town || 'Burlington',
      town: e.town,
      free: !!e.free,
      outdoor: e.indoorOutdoor === 'outdoor',
      indoor: e.indoorOutdoor === 'indoor',
      category: e.category,
      tags: e.tags || [],
      recurring: e.recurring || null,
      url: e.url || null,
      price: e.price || null,
      minPrice: e.minPrice,
      start, end, minsToStart, durMin,
      timeLabel: fmtTime(start) + (end ? '–' + fmtTime(end) : ''),
    });
  }
  return out;
}

function thingCandidates(data, ctx) {
  const things = data.things || [];
  const season = seasonNow(ctx);
  const out = [];
  for (const t of things) {
    const seasons = t.season || [];
    if (!seasons.includes('Year-Round') && !seasons.includes(season)) continue;
    const tods = t.time_of_day || [];
    // allow current block or the next one (afternoon pick can carry into evening)
    if (tods.length && !tods.includes(ctx.block) && !tods.includes(nextBlock(ctx.block))) continue;
    const strictlyOutdoor = t.indoor_outdoor === 'Outdoor';
    // after dark, an outdoor-only spot has to be MEANT for after dark
    if (strictlyOutdoor && ctx.dark && !tods.includes('Evening') && !tods.includes('Late Night')) continue;
    out.push({
      kind: 'thing',
      id: 'thing-' + t.id,
      title: t.name,
      venue: t.neighborhood || 'Burlington',
      free: t.cost_tier === 'Free',
      cheap: t.cost_tier === 'Free' || t.cost_tier === '$',
      outdoor: t.indoor_outdoor === 'Outdoor' || t.indoor_outdoor === 'Both',
      indoor: t.indoor_outdoor === 'Indoor' || t.indoor_outdoor === 'Both',
      strictlyOutdoor,
      goodFor: t.good_for || [],
      vibe: t.vibe || [],
      todMatch: tods.includes(ctx.block),
      blurb: t.blurb || '',
      costNote: t.cost_note || null,
      costTier: t.cost_tier,
      url: null,
    });
  }
  return out;
}

/* clubs.json carries only a free-text `when` ("Coffee Club Saturdays",
   "Tuesdays 7pm"). Best-effort day matching: if the text names specific
   weekdays and none of them is today, the club sits out. Generic schedules
   ("weekly", "most weeks", "varies") always pass — they're "join sometime"
   answers, which is also why clubs only show during waking hours. */

const DAY_WORDS = [
  [/\bsun(day)?s?\b/, 0], [/\bmon(day)?s?\b/, 1], [/\btue(s|sday)?s?\b/, 2],
  [/\bwed(nesday)?s?\b/, 3], [/\bthu(r|rs|rsday)?s?\b/, 4], [/\bfri(day)?s?\b/, 5],
  [/\bsat(urday)?s?\b/, 6],
];

function clubMatchesToday(when, weekday) {
  if (!when || typeof when !== 'string') return true;
  const s = when.toLowerCase();
  if (/daily|every day|most days|week|varies|check|see |month/.test(s)) return true;
  const days = DAY_WORDS.filter(([re]) => re.test(s)).map(([, d]) => d);
  if (days.length && /weekend/.test(s)) days.push(0, 6);
  if (!days.length) return true;
  return days.includes(weekday);
}

function clubCandidates(data, ctx) {
  // 2am is not the hour to point someone at a meetup
  if (ctx.hour < 8 || ctx.hour >= 22) return [];
  const clubs = (data.clubs && data.clubs.clubs) || [];
  return clubs
    .filter(c => c && typeof c.name === 'string' && c.name)
    .filter(c => clubMatchesToday(c.when, ctx.weekday))
    .map(c => ({
      kind: 'club',
      id: 'club-' + c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
      title: c.name,
      venue: typeof c.when === 'string' ? c.when : '',
      // only claim "free" when the club says so — most are, but we don't invent it
      free: /\bfree\b/i.test((c.what || '') + ' ' + (c.when || '')),
      outdoor: false,
      indoor: true,
      featured: !!c.featured,
      what: c.what || '',
      url: c.url || null,
    }));
}

function sunsetCandidate(data, ctx) {
  if (!ctx.sunset || ctx.minsToSunset == null) return null;
  if (ctx.minsToSunset < 25 || ctx.minsToSunset > 200) return null;
  const score = ctx.sunsetScore;
  if (score != null && score <= 3) return null; // don't send anyone to a gray wall
  const spots = (data.sunsetSpots && data.sunsetSpots.spots) || [];
  const spot = spots.length ? spots[Math.floor(Math.random() * Math.min(3, spots.length))] : null;
  const arrive = new Date(ctx.sunset - 20 * 60000);
  return {
    kind: 'sunset',
    id: 'sunset-tonight',
    title: spot ? `Sunset at ${spot.name}` : 'Catch the sunset',
    venue: spot ? spot.area : 'the waterfront',
    free: true,
    outdoor: true,
    score,
    spot,
    arrive,
    arriveLabel: fmtTime(arrive),
    sunsetLabel: fmtTime(ctx.sunset),
    walkMin: spot ? spot.walk_min : null,
    why: spot ? spot.why : null,
    url: 'https://guide.btownbrief.com/sunset.html',
  };
}

/* A swim only gets suggested when EVERY reading agrees: swim season, warm
   day, warm lake (recent gage reading — no "the lake's null°"), daylight
   with 90+ min to sunset (a known sunset, not a missing one), dry sky, and
   a beach whose clean test is fresh. Any missing piece = no swim. */
function beachCandidate(ctx) {
  if (ctx.month < 6 || ctx.month > 9) return null;
  if (ctx.temp == null || ctx.temp < 74) return null;
  if (ctx.rainingNow) return null;
  if (ctx.hour < 9) return null;
  if (ctx.minsToSunset == null || ctx.minsToSunset < 90) return null;
  if (!ctx.openBeaches.length) return null;
  if (ctx.lakeTemp == null || ctx.lakeTemp < 65) return null;
  const beach = ctx.openBeaches[Math.floor(Math.random() * ctx.openBeaches.length)];
  return {
    kind: 'beach',
    id: 'beach-swim',
    title: `Swim at ${beach.name}`,
    venue: 'Lake Champlain',
    free: true,
    outdoor: true,
    beach,
    url: 'https://guide.btownbrief.com/index.html#beaches',
  };
}

function seasonNow(ctx) {
  const m = ctx.month;
  if (m >= 6 && m <= 8) return 'Summer';
  if (m >= 9 && m <= 11) return 'Fall';
  if (m === 12 || m <= 2) return 'Winter';
  return 'Spring';
}

function nextBlock(block) {
  return { Morning: 'Afternoon', Afternoon: 'Evening', Evening: 'Late Night', 'Late Night': 'Late Night' }[block];
}

/* ---------- filtering by chips ---------- */

function passesChips(c, chips, ctx) {
  if (chips.has('free')) {
    if (!c.free) return false; // sunset + beach are always free; clubs only when they say so
  }
  if (chips.has('outside')) {
    if (!c.outdoor) return false;
    // don't send people outside into rain
    if (ctx.rainingNow && c.kind !== 'sunset') return false;
  }
  if (chips.has('people')) {
    if (c.kind === 'event' && !EVENT_PEOPLE_CATS.has(c.category)) return false;
    if (c.kind === 'thing' && !c.goodFor.includes('Groups & Friends')) return false;
    if (c.kind === 'beach') return false;
    // clubs + sunset (there are always people at the sunset) pass
  }
  if (chips.has('twohours')) {
    if (c.kind === 'event') {
      if (c.minsToStart > 150) return false;
      if (c.durMin && c.durMin > 200 && !isDropIn(c)) return false;
    }
    if (c.kind === 'thing' && c.goodFor.includes('Half Day')) return false;
    if (c.kind === 'club') return false; // clubs are "join sometime", not "right now"
  }
  return true;
}

function isDropIn(c) {
  // markets, ongoing fairs etc. — long window, you drop in for an hour
  return c.category === 'market' || (c.tags || []).includes('ongoing') || /market|festival|fair|open house/i.test(c.title);
}

/* ---------- scoring ---------- */

function scoreCandidate(c, ctx, chips) {
  let s = 0;
  const why = [];

  if (c.kind === 'event') {
    s = 55;
    if (c.minsToStart >= 20 && c.minsToStart <= 180) {
      s += 18;
      why.push(c.minsToStart <= 75 ? `it starts in ${c.minsToStart} min` : `it starts at ${fmtTime(c.start)}`);
    } else if (c.minsToStart < 20 && c.minsToStart > -45) {
      s += 10;
      why.push("it's on right now");
    }
    if (c.free) { s += 6; why.push("it's free"); }
    if (c.outdoor && ctx.rainingNow) { s -= 15; c.caution = true; }
    if (c.outdoor && !ctx.rainingNow && ctx.temp != null && ctx.temp >= 60) { s += 8; why.push(`it's ${ctx.temp}° out`); }
    if (c.indoor && (ctx.rainingNow || (ctx.popSoon ?? 0) > 60)) { s += 10; why.push("it's rain-proof"); }
    if (ctx.block === 'Evening' && ['music', 'comedy', 'theater', 'film'].includes(c.category)) s += 6;
    if (c.town === 'Burlington') s += 4;
    if ((c.tags || []).includes('ongoing')) s -= 16;       // daily-tour filler
    else if (/daily/i.test(c.recurring || '')) s -= 12;
    if (/weekly|monthly/i.test(c.recurring || '')) s -= 5; // slight nudge toward one-offs
  }

  if (c.kind === 'thing') {
    s = 42;
    if (c.todMatch) s += 8;
    if (c.vibe.includes("Underrated") || c.goodFor.includes("Locals' Pick")) { s += 5; }
    if (!ctx.rainingNow && ctx.temp != null && ctx.temp >= 70 && c.goodFor.includes('Sunny Day')) { s += 10; why.push(`it's made for a ${ctx.temp}° day`); }
    if ((ctx.rainingNow || (ctx.popSoon ?? 0) > 60) && c.goodFor.includes('Rainy Day')) { s += 12; why.push("it'll beat the rain"); }
    if ((ctx.popSoon ?? 0) > 70 && c.strictlyOutdoor) { s -= 15; c.caution = true; }
    if (c.free) why.push("it's free");
  }

  if (c.kind === 'club') {
    s = chips.has('people') ? 50 : 25;
    if (c.featured) s += 12;
    // Saturday morning is Coffee Club morning — the house always features its own
    if (c.featured && ctx.weekday === 6 && ctx.hour >= 7 && ctx.hour < 11) {
      s += 25;
      why.push("it's Saturday morning and coffee is happening");
    }
    why.push("it's real humans, not an algorithm");
  }

  if (c.kind === 'sunset') {
    s = 40 + (c.score ?? 5) * 5;
    if (ctx.minsToSunset >= 35 && ctx.minsToSunset <= 110) s += 15; // golden window approaching
    if (c.score != null && c.score >= 7) why.push(`the sunset scores ${c.score}/10 tonight`);
    why.push(`the sun's down at ${c.sunsetLabel}`);
  }

  if (c.kind === 'beach') {
    // beachCandidate guarantees temp + lakeTemp are real, recent numbers
    s = 58;
    if (ctx.temp >= 82) s += 12;
    why.push(`it's ${ctx.temp}° and the lake's ${ctx.lakeTemp}°`);
    why.push('the water tested clean');
  }

  c.score_ = s;
  c.why_ = why;
  return c;
}

/* ---------- the pick ---------- */

/* ctx.sunsetScore is set by the caller (app.js) via sunset-score.js
   before buildPool runs — it needs an extra async fetch. */
function buildPool(data, ctx, chips) {
  let pool = [
    ...eventCandidates(data, ctx),
    ...thingCandidates(data, ctx),
    ...clubCandidates(data, ctx),
  ];
  const sun = sunsetCandidate(data, ctx);
  if (sun) pool.push(sun);
  const beach = beachCandidate(ctx);
  if (beach) pool.push(beach);

  // Safety gate: when it's not okay to be outside on purpose — extreme
  // cold/heat, high wind, bad air, an active alert, or no weather read at
  // all — nothing strictly outdoor makes the pool. Chips can't reopen this.
  const risks = outdoorRisks(ctx);
  if (risks.length) pool = pool.filter(c => !isStrictlyOutdoor(c));
  // raining right now: outdoor-only spots are out entirely; the sunset only
  // stays if a real score says the sky is worth it (rain + high score = drama)
  if (ctx.rainingNow) {
    pool = pool.filter(c =>
      !(c.kind === 'thing' && c.strictlyOutdoor) &&
      c.kind !== 'beach' &&
      (c.kind !== 'sunset' || c.score != null));
  }

  pool = pool.filter(c => passesChips(c, chips, ctx));
  pool.forEach(c => scoreCandidate(c, ctx, chips));
  pool.sort((a, b) => b.score_ - a.score_);
  return pool;
}

/* Weighted-random pick from the top of the pool, avoiding recent answers. */
function pick(pool, recentIds) {
  const fresh = pool.filter(c => !recentIds.includes(c.id));
  const source = fresh.length ? fresh : pool;
  if (!source.length) return null;
  const top = source.slice(0, 10);
  const weights = top.map((c, i) => Math.exp(-i / 3.2)); // heavy head, live tail
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < top.length; i++) {
    r -= weights[i];
    if (r <= 0) return top[i];
  }
  return top[0];
}

export { buildContext, buildPool, pick, fmtTime, outdoorRisks, clubMatchesToday };
