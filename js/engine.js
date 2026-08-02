/* engine.js — turns live Burlington data + the current moment into ONE answer.

   Candidate sources:
     - today's real events (guide events pipeline, ~25 sources)
     - evergreen "things to do" (215 curated places/activities)
     - clubs & recurring meetups (for the "people" path)
     - tonight's sunset plan (score + spot + arrival time)
     - a swim (lake temp + beach status, when it's hot)

   Each candidate gets a context score; the spinner picks weighted-random
   from the top of the pile so respins feel alive but never feel dumb. */

/* ---------- context ---------- */

function buildContext(data) {
  const now = new Date();
  const w = data.weather || {};
  const nowW = w.now || {};
  const sun = w.sun || {};
  const hours = (w.hourly && w.hourly.hours) || [];

  const sunset = sun.sunset ? new Date(sun.sunset) : null;
  const minsToSunset = sunset ? Math.round((sunset - now) / 60000) : null;

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

  const hour = now.getHours();
  const block = hour < 11 ? 'Morning' : hour < 17 ? 'Afternoon' : hour < 22 ? 'Evening' : 'Late Night';

  const beaches = (data.beaches && data.beaches.beaches) || [];
  const openBeaches = beaches.filter(b => b.status === 'green');

  return {
    now,
    hour,
    block,
    isWeekend: [0, 6].includes(now.getDay()),
    dateStr: localDateStr(now),
    temp: nowW.temp_f ?? null,
    feels: nowW.feels_like_f ?? null,
    desc: (nowW.description || '').toLowerCase(),
    wind: nowW.wind_mph ?? null,
    popSoon,
    skyAtSunset,
    rainingNow: /rain|shower|drizzle|storm/.test((nowW.description || '').toLowerCase()),
    sunset,
    minsToSunset,
    lakeTemp: w.lake_gage ? w.lake_gage.water_temp_f : null,
    openBeaches,
    aqi: w.air ? w.air.aqi : null,
    alerts: (w.alerts && w.alerts.active) || [],
    sunsetScore: null, // filled below
  };
}

function localDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- constraint chips ---------- */
/* keys: 'free' | 'outside' | 'people' | 'twohours' */

const EVENT_PEOPLE_CATS = new Set([
  'music', 'community', 'market', 'food-drink', 'comedy', 'games', 'sports', 'family',
]);

/* ---------- candidate builders ---------- */

function eventCandidates(data, ctx) {
  const events = (data.events && data.events.events) || [];
  const out = [];
  for (const e of events) {
    if (e.status && e.status !== 'active') continue;
    if (e.date !== ctx.dateStr) continue;
    const start = e.start ? new Date(e.start) : null;
    const end = e.end ? new Date(e.end) : null;
    if (!start) continue;
    const minsToStart = Math.round((start - ctx.now) / 60000);
    const minsSinceStart = -minsToStart;
    const durMin = end ? Math.round((end - start) / 60000) : null;
    // skip if it's over, or ends within 30 min
    if (end && (end - ctx.now) / 60000 < 30) continue;
    // skip if it started > 45 min ago and we don't know it runs long
    if (minsSinceStart > 45 && !(durMin && durMin >= 180)) continue;
    // skip things that start too far away to be an answer to "now"
    if (minsToStart > 6 * 60) continue;

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
  const season = seasonNow(ctx.now);
  const out = [];
  for (const t of things) {
    const seasons = t.season || [];
    if (!seasons.includes('Year-Round') && !seasons.includes(season)) continue;
    const tods = t.time_of_day || [];
    // allow current block or the next one (afternoon pick can carry into evening)
    if (tods.length && !tods.includes(ctx.block) && !tods.includes(nextBlock(ctx.block))) continue;
    out.push({
      kind: 'thing',
      id: 'thing-' + t.id,
      title: t.name,
      venue: t.neighborhood || 'Burlington',
      free: t.cost_tier === 'Free',
      cheap: t.cost_tier === 'Free' || t.cost_tier === '$',
      outdoor: t.indoor_outdoor === 'Outdoor' || t.indoor_outdoor === 'Both',
      indoor: t.indoor_outdoor === 'Indoor' || t.indoor_outdoor === 'Both',
      strictlyOutdoor: t.indoor_outdoor === 'Outdoor',
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

function clubCandidates(data) {
  const clubs = (data.clubs && data.clubs.clubs) || [];
  return clubs.map(c => ({
    kind: 'club',
    id: 'club-' + c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
    title: c.name,
    venue: c.when || '',
    free: true,
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

function beachCandidate(ctx) {
  if (ctx.temp == null || ctx.temp < 74) return null;
  if (ctx.rainingNow) return null;
  if (ctx.hour < 9 || (ctx.minsToSunset != null && ctx.minsToSunset < 90)) return null;
  if (!ctx.openBeaches.length) return null;
  if (ctx.lakeTemp != null && ctx.lakeTemp < 65) return null;
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

function seasonNow(d) {
  const m = d.getMonth() + 1;
  if (m >= 6 && m <= 8) return 'Summer';
  if (m >= 9 && m <= 11) return 'Fall';
  if (m === 12 || m <= 2) return 'Winter';
  return 'Spring';
}

function nextBlock(block) {
  return { Morning: 'Afternoon', Afternoon: 'Evening', Evening: 'Late Night', 'Late Night': 'Late Night' }[block];
}

function fmtTime(d) {
  let h = d.getHours(); const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')}${ampm}` : `${h}${ampm}`;
}

/* ---------- filtering by chips ---------- */

function passesChips(c, chips, ctx) {
  if (chips.has('free')) {
    if (c.kind === 'event' && !c.free) return false;
    if (c.kind === 'thing' && !c.free) return false;
    // sunset, beach, clubs: always free
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
    if (c.outdoor && !ctx.rainingNow && ctx.temp >= 60) { s += 8; why.push(`it's ${ctx.temp}° out`); }
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
    if (!ctx.rainingNow && ctx.temp >= 70 && c.goodFor.includes('Sunny Day')) { s += 10; why.push(`it's made for a ${ctx.temp}° day`); }
    if ((ctx.rainingNow || (ctx.popSoon ?? 0) > 60) && c.goodFor.includes('Rainy Day')) { s += 12; why.push("it'll beat the rain"); }
    if (ctx.rainingNow && c.strictlyOutdoor) s -= 25;
    if (c.free) why.push("it's free");
  }

  if (c.kind === 'club') {
    s = chips.has('people') ? 50 : 25;
    if (c.featured) s += 12;
    // Saturday morning is Coffee Club morning — the house always features its own
    if (c.featured && ctx.now.getDay() === 6 && ctx.hour >= 7 && ctx.hour < 11) {
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
    ...clubCandidates(data),
  ];
  const sun = sunsetCandidate(data, ctx);
  if (sun) pool.push(sun);
  const beach = beachCandidate(ctx);
  if (beach) pool.push(beach);

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

export { buildContext, buildPool, pick, fmtTime };
