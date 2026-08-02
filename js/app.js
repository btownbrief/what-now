/* app.js — the one-screen loop: read the sky, offer the paths, spin, answer.
   Nothing here scrolls forever. The end state is the phone in a pocket. */

import { loadAll } from './data.js';
import { buildContext, buildPool, pick, fmtTime } from './engine.js';
import { fetchCloudLayers, computeSunsetScore } from './sunset-score.js';

const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  ctx: null,
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

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

init();

async function init() {
  const [data, om] = await Promise.all([loadAll(), fetchCloudLayers()]);
  state.data = data;

  const ctx = buildContext(data);
  const ss = computeSunsetScore(ctx.sunset, om, data.weather);
  ctx.sunsetScore = ss ? ss.score : null;
  ctx.sunsetDegraded = ss ? ss.degraded : false;
  state.ctx = ctx;

  paintPhase(ctx);
  renderGreeting(ctx);
  renderContextStrip(ctx);
  renderTonight(ctx, data);
  renderFooter(ctx, data);

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
  // ?chips=free,outside preselects paths, ?auto=1 spins on load, ?done=1 shows the end state
  const qs = new URLSearchParams(location.search);
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
    const h = now.getHours();
    phase = h < 6 || h >= 21 ? 'night' : h < 9 ? 'dawn' : h < 11 ? 'morning' : h < 19 ? 'day' : 'dusk';
  }
  document.documentElement.dataset.phase = phase;
}

function renderGreeting(ctx) {
  const day = ctx.now.toLocaleDateString('en-US', { weekday: 'long' });
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

/* His original idea, kept pure: ignore the filters, ignore the scores,
   pull anything from the whole hat. Chaos as a feature. */
function wildcard() {
  if (!state.ready) return;
  state.rollId += 1; // cancel any roll in flight
  const pool = buildPool(state.data, state.ctx, new Set());
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
  $('answer-kicker').textContent = 'honestly?';
  $('answer-title').textContent = 'Nothing fits all that.';
  $('answer-meta').textContent = 'Loosen a filter — or skip the plan and take the waterfront walk.';
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

  $('pool-note').textContent = `picked from ${state.poolSize} things that fit right now`;
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
  }
  return bits.filter(Boolean).join(' · ');
}

function blurbFor(c) {
  if (c.kind === 'thing') return c.blurb || '';
  if (c.kind === 'club') return trim(c.what, 160);
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
  if (score == null) {
    line = `Sun’s down at <strong>${fmtTime(ctx.sunset)}</strong>. No read on the sky yet — look west anyway.`;
  } else if (score >= 6.5) {
    line = `Sunset scores <strong>${fmt10(score)}</strong>. ${spot ? `Be at <strong>${esc(spot.name)}</strong> by <strong>${by}</strong>.` : `Be somewhere west-facing by <strong>${by}</strong>.`}`;
    el.classList.add('golden');
    if (ctx.minsToSunset <= 80) $('tonight').querySelector('.tonight-eyebrow').textContent = 'tonight — leave soon';
  } else if (score >= 4.5) {
    line = `Sunset scores <strong>${fmt10(score)}</strong> — worth a walk if you’re near the water around <strong>${by}</strong>.`;
  } else {
    line = `Sunset’s a <strong>${fmt10(score)}</strong> tonight — socked in. Indoor kind of evening.`;
  }
  if (ctx.sunsetDegraded && score != null) line += ' <em>(rough read)</em>';
  $('tonight-line').innerHTML = line;
  el.hidden = false;
}

function renderFooter(ctx, data) {
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
}

/* ---------- done ---------- */

function showDone() {
  const c = state.current;
  $('done-what').textContent = c ? `${c.title}${metaLine(c) ? ' — ' + metaLine(c) : ''}` : '';
  $('done').hidden = false;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
