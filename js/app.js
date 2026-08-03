/* app.js — the one-screen loop: read the sky, offer the paths, spin, answer.
   Nothing here scrolls forever. The end state is the phone in a pocket. */

import { loadAll } from './data.js';
import { buildContext, buildPool, pick, fmtTime, outdoorRisks } from './engine.js';
import { fetchCloudLayers, computeSunsetScore } from './sunset-score.js';

const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  ctx: null,
  om: null,         // Open-Meteo payload, kept so mode switches can rescore the sunset
  mode: 'now',      // 'now' | 'tonight' | 'tomorrow'
  chips: new Set(),
  recent: loadRecent(), // recent answer ids — survives reloads so tomorrow opens fresh
  current: null,
  poolSize: 0,
  ready: false,
  rollId: 0,        // invalidates an in-flight roll if a new spin starts
};

/* Remember what we already suggested for ~20 hours. "Again" should never
   repeat itself, and neither should tomorrow morning's first spin. */
function loadRecent() {
  try {
    const cut = Date.now() - 20 * 3600 * 1000;
    return JSON.parse(localStorage.getItem('wn_recent') || '[]')
      .filter((x) => x.at > cut)
      .map((x) => x.id);
  } catch { return []; }
}

function rememberAnswer(id) {
  state.recent.push(id);
  if (state.recent.length > 8) state.recent.shift();
  try {
    const now = Date.now();
    localStorage.setItem('wn_recent', JSON.stringify(state.recent.map((rid) => ({ id: rid, at: now }))));
  } catch { /* fine */ }
}

/* ---------- follow-through: "you went to X — worth it?" ----------
   All local, all optional. Commits land in wn_went; the next open (3h–48h
   later) asks once, and the 👍/👎 becomes a light scoring nudge by
   kind:category. Dismissing counts as answered — the app never nags. */

function loadWent() {
  try { return JSON.parse(localStorage.getItem('wn_went') || '[]'); } catch { return []; }
}

function saveWent(list) {
  try { localStorage.setItem('wn_went', JSON.stringify(list.slice(-20))); } catch { /* fine */ }
}

function rememberWent(c) {
  const list = loadWent();
  list.push({ id: c.id, title: c.title, kind: c.kind, category: c.category || '', at: Date.now(), rating: null, asked: false });
  saveWent(list);
}

function loadAffinity() {
  const map = {};
  for (const w of loadWent()) {
    if (w.rating == null) continue;
    const key = w.kind + ':' + (w.category || '');
    map[key] = (map[key] || 0) + w.rating;
  }
  return map;
}

function maybeAskFollowup() {
  const list = loadWent();
  const age = (w) => Date.now() - w.at;
  const due = [...list].reverse().find((w) => w.rating == null && !w.asked && age(w) > 3 * 3600 * 1000 && age(w) < 48 * 3600 * 1000);
  if (!due) return;
  const day = new Date(due.at).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
  $('followup-line').textContent = `You went to ${due.title} on ${day} — worth it?`;
  $('followup').hidden = false;
  const settle = (rating) => {
    due.rating = rating;
    due.asked = true;
    saveWent(list);
    if (state.ctx) state.ctx.affinity = loadAffinity();
    $('followup').hidden = true;
  };
  $('followup-yes').addEventListener('click', () => settle(1), { once: true });
  $('followup-no').addEventListener('click', () => settle(-1), { once: true });
  $('followup-skip').addEventListener('click', () => settle(null), { once: true });
}

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

init();

/* Build (or rebuild, on a mode switch) the context for the current mode,
   scoring the sunset that belongs to the window being planned. */
function makeCtx() {
  const ctx = buildContext(state.data, new Date(), state.mode);
  const ss = computeSunsetScore(ctx.sunsetT, state.om, state.data.weather);
  ctx.sunsetScore = ss ? ss.score : null;
  ctx.sunsetDegraded = ss ? ss.degraded : false;
  ctx.affinity = loadAffinity();
  return ctx;
}

function setMode(mode) {
  state.mode = mode;
  state.ctx = makeCtx();
  document.querySelectorAll('.mode').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  });
  // if an answer is up, the new window should talk back immediately
  if (!$('answer').hidden) doSpin(true);
}

async function init() {
  // Guide feeds gate the button (each request has its own timeout, so this
  // is bounded); Open-Meteo does NOT — the sunset score starts on the
  // degraded NWS read and upgrades in place when the cloud layers land.
  const { data, status } = await loadAll();
  state.data = data;
  state.ctx = makeCtx();
  const ctx = state.ctx;

  fetchCloudLayers().then((om) => {
    if (!om) return;
    state.om = om;
    const cur = state.ctx;
    const better = computeSunsetScore(cur.sunsetT, om, data.weather);
    if (!better) return;
    cur.sunsetScore = better.score;
    cur.sunsetDegraded = better.degraded;
    renderContextStrip(cur);
    renderTonight(cur, data);
  });

  paintPhase(ctx);
  renderGreeting(ctx);
  renderContextStrip(ctx);
  renderTonight(ctx, data);
  renderFooter(ctx, data, status);
  maybeAskFollowup();

  // offline app shell (data still needs the network; the app itself doesn't)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* fine — still a website */ });
  }

  // planning modes: "tonight" only makes sense before the evening's over
  if (ctx.hour >= 21) $('mode-tonight').hidden = true;
  document.querySelectorAll('.mode').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });

  state.ready = true;
  const spin = $('spin');
  spin.disabled = false;
  $('spin-label').textContent = 'what now?';
  spin.addEventListener('click', () => doSpin());

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.chip;
      const on = state.chips.has(key);
      if (on) state.chips.delete(key); else state.chips.add(key);
      chip.setAttribute('aria-pressed', String(!on));
      // if an answer is up, the new constraint should talk back immediately
      if (!$('answer').hidden) doSpin(true);
    });
  });

  $('again').addEventListener('click', () => doSpin(true));
  $('commit').addEventListener('click', showDone);
  $('done-back').addEventListener('click', () => { $('done').hidden = true; });
  $('wild').addEventListener('click', wildcard);
  $('share').addEventListener('click', shareAnswer);

  // preview hooks, same spirit as the sunset page's ?sscore= overrides:
  // ?chips=free,outside preselects paths, ?auto=1 spins on load,
  // ?mode=tonight|tomorrow preselects the window, ?done=1 shows the end state
  const qs = new URLSearchParams(location.search);
  if (['tonight', 'tomorrow'].includes(qs.get('mode'))) setMode(qs.get('mode'));
  if (qs.get('chips')) {
    qs.get('chips').split(',').forEach((k) => {
      const chip = document.querySelector(`.chip[data-chip="${CSS.escape(k)}"]`);
      if (chip) { state.chips.add(k); chip.setAttribute('aria-pressed', 'true'); }
    });
  }
  if (qs.get('auto')) doSpin(true);
  if (qs.get('wild')) wildcard();
  if (qs.get('done')) { if (!state.current) doSpin(true); showDone(); }
}

/* ---------- phase + header ---------- */

function paintPhase(ctx) {
  const { now } = ctx;
  const sun = state.data.weather && state.data.weather.sun;
  let phase = 'day';
  if (sun && sun.sunrise && sun.sunset) {
    const rise = new Date(sun.sunrise), set = new Date(sun.sunset);
    const m = (a, b) => (a - b) / 60000;
    if (m(now, rise) < -40) phase = 'night';
    else if (m(now, rise) < 40) phase = 'dawn';
    else if (now.getHours() < 11) phase = 'morning';
    else if (m(set, now) > 75) phase = 'day';
    else if (m(now, set) < 10) phase = 'golden';
    else if (m(now, set) < 50) phase = 'dusk';
    else phase = 'night';
  } else {
    const h = ctx.hour; // Burlington hour, not device hour
    phase = h < 6 || h >= 21 ? 'night' : h < 9 ? 'dawn' : h < 11 ? 'morning' : h < 19 ? 'day' : 'dusk';
  }
  document.documentElement.dataset.phase = phase;
}

function renderGreeting(ctx) {
  // ctx.hour is already Burlington time; keep the weekday in the same zone
  const day = ctx.now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
  const part = ctx.hour < 5 ? 'Late night' : ctx.hour < 12 ? `${day} morning` : ctx.hour < 17 ? `${day} afternoon` : ctx.hour < 22 ? `${day} evening` : 'Late night';
  $('greeting').textContent = `${part} in Burlington.`;
}

function renderContextStrip(ctx) {
  const bits = [];
  if (ctx.temp != null) bits.push(`${ctx.temp}° ${ctx.desc || ''}`.trim());
  if (ctx.lakeTemp != null) bits.push(`lake ${ctx.lakeTemp}°`);
  if (ctx.sunset && ctx.minsToSunset > 0) {
    let s = `sunset ${fmtTime(ctx.sunset)}`;
    if (ctx.sunsetScore != null) s += ` · scores ${fmt10(ctx.sunsetScore)}`;
    bits.push(s);
  }
  if (ctx.aqi != null && ctx.aqi > 100) bits.push(`AQI ${ctx.aqi} — smoky`);
  if (ctx.alerts.length) bits.push('⚠ weather alert');
  $('ctx-strip').innerHTML = bits.length
    ? bits.map(esc).join('<span class="ctx-sep">·</span>')
    : 'couldn’t read the sky — going on vibes';
}

function fmt10(n) { return `${Number.isInteger(n) ? n : n.toFixed(1)}/10`; }

/* ---------- the spin ---------- */

function doSpin(short = false) {
  if (!state.ready) return;
  const roll = ++state.rollId; // cancels any roll already in flight
  const pool = buildPool(state.data, state.ctx, state.chips);
  state.poolSize = pool.length;

  const answerEl = $('answer');
  const card = answerEl.querySelector('.answer-card');
  answerEl.hidden = false;
  $('spin').hidden = true;

  if (!pool.length) {
    card.classList.remove('rolling');
    renderEmpty();
    return;
  }

  const choice = pick(pool, state.recent);
  state.current = choice;
  rememberAnswer(choice.id);

  if (REDUCED || short) {
    card.classList.remove('rolling');
    renderAnswer(choice);
    return;
  }

  // slot-machine roll: flick through what else is in the hat, then settle
  card.classList.add('rolling');
  const titles = pool.slice(0, 12).map(c => c.title).sort(() => Math.random() - .5);
  let i = 0, delay = 65;
  $('answer-kicker').textContent = 'spinning';
  $('answer-meta').textContent = '';
  $('answer-blurb').textContent = '';
  $('answer-link').hidden = true;
  const step = () => {
    if (roll !== state.rollId) return; // a newer spin took over
    if (delay > 260) {
      card.classList.remove('rolling');
      renderAnswer(choice);
      return;
    }
    $('answer-title').textContent = titles[i % titles.length];
    i += 1;
    delay *= 1.22;
    setTimeout(step, delay);
  };
  step();
}

/* Ignore the filters, ignore the RANKING — but not the ground rules. The
   hat only ever holds things that are safe and sensible right now (the
   engine bakes that into the pool), and anything the scorer flagged with a
   caution (outdoor event in the rain, walk ahead of a downpour) stays out.
   Within that: uniform chaos, as intended. */
function wildcard() {
  if (!state.ready) return;
  state.rollId += 1; // cancel any roll in flight
  const pool = buildPool(state.data, state.ctx, new Set()).filter((c) => !c.caution);
  if (!pool.length) return;
  $('answer').hidden = false;
  $('spin').hidden = true;
  const choice = pool[Math.floor(Math.random() * pool.length)];
  state.current = choice;
  rememberAnswer(choice.id);
  state.poolSize = pool.length;
  document.querySelector('.answer-card').classList.remove('rolling');
  renderAnswer(choice);
  $('answer-kicker').textContent = 'pure chance';
  $('pool-note').textContent = `one of ${pool.length}, straight from the hat`;
}

/* The best answer to "I want people around" is bringing one. */
async function shareAnswer() {
  const c = state.current;
  if (!c) return;
  const text = `${c.title}${metaLine(c) ? ' — ' + metaLine(c) : ''}. Coming?`;
  const url = c.url || undefined;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'What Now', text, url });
    } else {
      await navigator.clipboard.writeText(text + (url ? ' ' + url : ''));
      const btn = $('share');
      btn.textContent = 'copied — send it';
      setTimeout(() => { btn.textContent = 'drag a friend →'; }, 1600);
    }
  } catch { /* user backed out of the share sheet — no drama */ }
}

function renderEmpty() {
  const ctx = state.ctx;
  // Only pitch the waterfront walk when a walk is actually a good idea in
  // the window being planned: daylight, dry, above-freezing-ish, and
  // nothing dangerous in the sky.
  const walkable = ctx && !ctx.darkAtTarget && !ctx.rainT
    && ctx.tempT != null && ctx.tempT >= 40
    && !outdoorRisks(ctx).length;
  $('answer-kicker').textContent = 'honestly?';
  $('answer-title').textContent = 'Nothing fits all that.';
  $('answer-meta').textContent = walkable
    ? 'Loosen a filter — or skip the plan and take the waterfront walk.'
    : 'Loosen a filter — or call it: some hours are for staying in.';
  $('answer-blurb').textContent = '';
  $('answer-link').hidden = true;
  $('pool-note').textContent = '';
}

function renderAnswer(c) {
  $('answer-kicker').textContent = c.why_ && c.why_.length ? 'because ' + c.why_.slice(0, 3).join(' · ') : 'why not';
  $('answer-title').textContent = c.title;
  $('answer-meta').textContent = metaLine(c);
  $('answer-blurb').textContent = blurbFor(c);

  const link = $('answer-link');
  if (c.url) { link.href = c.url; link.hidden = false; } else { link.hidden = true; }

  $('pool-note').textContent = `picked from ${state.poolSize} things that fit ${modeWord()}${smallHatNote()}`;
}

function modeWord() {
  return state.mode === 'tonight' ? 'tonight' : state.mode === 'tomorrow' ? 'tomorrow' : 'right now';
}

/* When the hat is small, say why — a thin pool at a rainy 2am is honesty,
   not failure. */
function smallHatNote() {
  if (state.poolSize >= 8) return '';
  const ctx = state.ctx;
  const reasons = [];
  if (ctx.block === 'Late Night' && state.mode === 'now') reasons.push("it's late");
  if (ctx.rainT) reasons.push("it's raining");
  else if (ctx.tempT != null && ctx.tempT <= 20) reasons.push("it's bitter out");
  if (ctx.tempT == null) reasons.push("we can't read the sky");
  if (state.chips.size >= 2) reasons.push('the filters are tight');
  return reasons.length ? ` — the hat's small because ${reasons.slice(0, 2).join(' and ')}` : '';
}

function metaLine(c) {
  const bits = [];
  if (c.kind === 'event') {
    bits.push(c.venue);
    if (c.timeLabel) bits.push(c.timeLabel);
    bits.push(c.free ? 'free' : (c.minPrice != null && c.minPrice > 0 ? `from $${c.minPrice}` : ''));
  } else if (c.kind === 'thing') {
    bits.push(c.venue);
    if (c.costNote) bits.push(c.costNote);
    else if (c.costTier) bits.push(c.costTier === 'Free' ? 'free' : c.costTier);
  } else if (c.kind === 'sunset') {
    bits.push(`be there by ${c.arriveLabel}`);
    if (c.walkMin != null) bits.push(`${c.walkMin} min walk from Church St`);
    bits.push(`sun's down ${c.sunsetLabel}`);
  } else if (c.kind === 'beach') {
    bits.push(c.venue);
    if (c.beach && c.beach.sampled) bits.push('water tested clean');
  } else if (c.kind === 'club') {
    bits.push(c.venue);
  } else if (c.kind === 'hobby') {
    bits.push(c.venue); // the season line
  }
  return bits.filter(Boolean).join(' · ');
}

function blurbFor(c) {
  if (c.kind === 'thing') return c.blurb || '';
  if (c.kind === 'club') return trim(c.what, 160);
  if (c.kind === 'hobby') return trim(c.startLine ? `${c.what} Start: ${c.startLine}` : c.what, 280);
  if (c.kind === 'sunset') return c.why || 'Look west. That’s the whole assignment.';
  if (c.kind === 'beach') return 'Towel, water, done. This is what the lake is for.';
  return '';
}

function trim(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
}

/* ---------- tonight + footer ---------- */

function renderTonight(ctx, data) {
  if (!ctx.sunset || ctx.minsToSunset == null || ctx.minsToSunset <= 0 || ctx.minsToSunset > 10 * 60) return;
  const el = $('tonight');
  const score = ctx.sunsetScore;
  const spots = (data.sunsetSpots && data.sunsetSpots.spots) || [];
  const spot = spots[0];
  const by = fmtTime(new Date(ctx.sunset - 20 * 60000));
  let line;
  // this re-renders when the cloud layers arrive, so reset before styling
  el.classList.remove('golden');
  el.querySelector('.tonight-eyebrow').textContent = 'tonight';
  if (score == null) {
    line = `Sun’s down at <strong>${fmtTime(ctx.sunset)}</strong>. No read on the sky yet — look west anyway.`;
  } else if (score >= 6.5) {
    line = `Sunset scores <strong>${fmt10(score)}</strong>. ${spot ? `Be at <strong>${esc(spot.name)}</strong> by <strong>${by}</strong>.` : `Be somewhere west-facing by <strong>${by}</strong>.`}`;
    el.classList.add('golden');
    if (ctx.minsToSunset <= 80) el.querySelector('.tonight-eyebrow').textContent = 'tonight — leave soon';
  } else if (score >= 4.5) {
    line = `Sunset scores <strong>${fmt10(score)}</strong> — worth a walk if you’re near the water around <strong>${by}</strong>.`;
  } else {
    line = `Sunset’s a <strong>${fmt10(score)}</strong> tonight — socked in. Indoor kind of evening.`;
  }
  if (ctx.sunsetDegraded && score != null) line += ' <em>(rough read)</em>';
  $('tonight-line').innerHTML = line;
  el.hidden = false;
}

function renderFooter(ctx, data, status) {
  const events = (data.events && data.events.events) || [];
  const today = events.filter(e => e.date === ctx.dateStr && e.status !== 'inactive').length;
  if (today) {
    $('today-count').innerHTML =
      `<a href="https://guide.btownbrief.com/events.html" rel="noopener">${today} real things happening today →</a>`;
  }
  const gen = data.events && data.events.generated;
  if (gen) {
    const mins = Math.max(0, Math.round((Date.now() - new Date(gen)) / 60000));
    $('freshness').textContent = mins < 90 ? `Events refreshed ${mins} min ago.` : `Events refreshed ${Math.round(mins / 60)}h ago.`;
  }

  // Say what the data actually is. "Live" is earned, not assumed.
  const states = Object.values(status || {});
  const current = states.filter(s => s.state === 'live' || s.state === 'cache').length;
  let line;
  if (!states.length || current === states.length) {
    line = 'Live data from';
  } else if (current === 0) {
    line = 'Couldn’t reach the guide — nothing here is current. Data (when it loads) comes from';
  } else {
    const bad = states.length - current;
    line = `Live data (mostly) from`;
    $('freshness').textContent =
      `${bad} of ${states.length} feeds ${bad === 1 ? 'is' : 'are'} stale or unreachable right now. ` +
      ($('freshness').textContent || '');
  }
  $('data-state').textContent = line;
}

/* ---------- done ---------- */

function showDone() {
  const c = state.current;
  if (c) rememberWent(c); // so next open can ask "worth it?"
  $('done-what').textContent = c ? `${c.title}${metaLine(c) ? ' — ' + metaLine(c) : ''}` : '';
  $('done').hidden = false;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
