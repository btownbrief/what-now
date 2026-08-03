# What Now

**One good answer to "what do I want to do today?" — then put the phone down.**

This is the anti-feed. You open it instead of Instagram, it reads the actual sky
and the actual events calendar, and it hands you one concrete thing to do in
Burlington right now. If it's not the thing, you spin again. When it is, you tap
**I'm going** and the app's last words are *"Now put the phone down."*

There is no scroll, no ranking, no engagement loop. The whole product is one
screen and one decision.

## How it works

1. **It reads the moment.** Time of day, day of week, temperature, rain chance,
   lake temperature, beach water quality, air quality, and tonight's sunset —
   all live.
2. **You pick the window** — *now · tonight · tomorrow*. Planning modes
   judge conditions at the target time: tonight leans on the hourly
   forecast, tomorrow on the NWS day period.
3. **You optionally narrow the path**, in your own words:
   *I'm broke · get me outside · people, please · I've got ~2 hours ·
   close by · teach me something.* "Close by" only claims what it can
   verify: coordinates within a ~15-minute walk of Church Street, or the
   walkable core neighborhoods. "Teach me something" swaps the pool for the
   guide's 39 hobbies-with-on-ramps, month-gated to what's in season.
4. **You hit the big button.** A quick slot-machine roll, then one answer with
   its reasoning spelled out: *"because it starts in 45 min · it's free ·
   it's 77° out."*
5. **"Nah, again"** re-spins (it remembers what it already suggested for ~20
   hours, so tomorrow doesn't open with yesterday's answer). **"I'm going"**
   ends the session on purpose.
6. Under the answer: **🎲 pure chance** (ignore the filters and the ranking —
   uniform from the hat, though the hat itself only ever holds safe,
   right-now answers) and **drag a friend →** (share sheet on phones,
   copy-to-clipboard elsewhere).

## Ground rules

The pool is gated where it's built, so no path around the engine — chips,
respins, pure chance — can reach an unsafe or nonsensical answer:

- **Burlington time.** "Today", dayparts, and clock displays are computed in
  `America/New_York`, not device time. 2 a.m. is late night, not morning,
  and an event six hours out is not an answer to "now" (the window is ~3h).
- **Outdoor safety.** Dangerous cold or heat (feels-like ≤ 15° / ≥ 100°),
  high wind, unhealthy air (AQI > 150), any active weather alert, or *no
  current weather reading at all* removes everything strictly outdoor from
  the pool. Rain removes outdoor-only spots; after dark, outdoor-only spots
  must be tagged for the evening. A weather feed more than 3h old counts as
  no reading.
- **The swim is earned.** A swim appears only in season (Jun–Sep), in
  daylight with 90+ minutes to a *known* sunset, when it's 74°+, the lake
  gage reading is real, recent, and 65°+, and the beach's clean water test
  is fresh (the city samples twice a week). Any missing piece = no swim.
- **Clubs keep their hours.** Clubs only show 8 a.m.–10 p.m., day-specific
  schedules ("Tuesdays 7pm") only show on their day, and a club is only
  called free when it says it's free.
- **Planning is forecast-honest.** Tonight uses the hourly read nearest
  7 p.m.; tomorrow uses the NWS day period. A missing forecast for the
  window = no outdoor answers for that window, same as a missing current
  reading. The swim stays a now-only answer — tomorrow's water status is
  tomorrow's news.
- **Taste nudges, privately.** After you tap "I'm going," the next open
  asks *"worth it?"* once. The 👍/👎 lives in localStorage only and nudges
  that category a few points — it never removes anything and never leaves
  the phone. No accounts, no server, no tracking.
- **Honesty on failure.** Every fetch has an 8s timeout; a stalled feed
  can't hold the app at "warming up". Stale caches are served for at most
  24h and the footer says what's actually live — "Live data" is earned,
  not assumed.

## Where answers come from

Everything is fetched client-side at runtime from the guide's public JSON
(CORS is open on `guide.btownbrief.com`); nothing here has its own backend or
pipeline:

| Source | Endpoint | Used for |
|---|---|---|
| Events pipeline (~25 sources, ~2,000 events) | `data/events/events.json` | today's real events — the core pool |
| 215 curated "things to do" | `data/things.json` | evergreen answers, tagged by cost / time-of-day / vibe / weather fit |
| Clubs & recurring meetups | `data/clubs.json` | the "people, please" path |
| Weather + lake + sun + AQI | `data/weather/latest.json` | context scoring, the header strip, phase-aware sky |
| Beach water quality | `data/weather/beaches.json` | the "go swim" answer, only when beaches test clean |
| Sunset spots | `data/sunset-spots.json` | "be at Oakledge by 7:56" |
| 39 hobbies with local on-ramps | `data/hobbies.json` | the "teach me something" path, month-gated |
| Open-Meteo cloud layers (keyless) | `api.open-meteo.com` | the sunset score |

The **sunset score** is a port of the guide's `sunset.js` math: high clouds are
the canvas (+), low clouds are the killer (−), humidity/visibility/rain/AQI
nudge, clamped 0–10. If Open-Meteo is unreachable it degrades to NWS total sky
cover and says so.

The **engine** (`js/engine.js`) builds a candidate pool from all of the above,
filters by the chips, scores each candidate against the moment (an event
starting in 40 minutes beats one in 5 hours; patios score up at 77°, museums
score up in rain; daily-recurring tourist filler scores down), then picks
weighted-random from the top so re-spins stay good *and* surprising.

## Stack

Static vanilla JS (ES modules), no build step, no dependencies. Btown Brief
reel design family: black ground, glass cards, Instrument Serif + DM Sans
(self-hosted woff2 — no Google Fonts request), gold accent, and a phase-aware
sky gradient (dawn/day/golden/dusk/night from real sun times). Shared family
nav via `play.btownbrief.com/nav.js`. A service worker caches the app shell
for offline opens; data is never served from it, so the freshness rules in
`data.js` stay in charge.

Installable: web manifest + icons + apple-touch meta. Add to Home Screen and
it opens standalone, which is the intended way to use it — in standalone mode
the family nav hides itself so it reads as an app, not a page.

Small house rules baked into the scoring: the featured club (our own Meetup)
gets a Saturday-morning Coffee Club boost, and when the sunset scores ≥6.5
the tonight card goes gold and starts saying "leave soon."

## Run locally

```
python3 -m http.server 8642
open http://localhost:8642
```

Preview hooks (same spirit as the sunset page's `?sscore=`):
`?auto=1` spins on load · `?chips=free,outside` preselects paths ·
`?mode=tonight|tomorrow` preselects the window ·
`?wild=1` pulls a pure-chance answer · `?done=1` shows the end state.

## Tests

The engine is a pure ES module, so the adversarial-review edge cases run
straight in Node (the UTC env proves Burlington time wins over device time):

```
TZ=UTC node --test test/engine.test.mjs
```

`scripts/check-contracts.mjs` proves the deployed guide feeds still carry
every field the app consumes (a rename would otherwise silently empty part
of the pool); CI runs both on every push and every Monday morning.

## Honest limitations (v1)

- Planning covers tonight and tomorrow; nothing further out — a decision
  app, not a calendar.
- Data caches in localStorage for 10 minutes (stale copies serve for at most
  24h after a failed fetch, labeled as such) — fine for a decision app.
- "Close by" can only vouch for entries with coordinates or a walkable-core
  neighborhood — events without coordinates don't count as close, even when
  they are.
