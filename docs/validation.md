# Demo validation — 2026-10-12

The working demo is deployed at
[hackernews-realtime.vercel.app](https://hackernews-realtime.vercel.app/), backed
by a dedicated Neon staging project. Implementation is complete. Launch
acceptance in [PLAN.md](../PLAN.md) is still open where listed below.

## Completed checks

- A checkout with empty SDK packages, source checkout and dependencies fetched
  pinned Neon commit `3c08c9b45a919515a7b79977fa6267f828ce52d5`, verified package
  hashes, installed the frozen app lockfile, type checked, ran tests and built
  the production app. A second bootstrap produced identical normalized hashes.
- Unit coverage checks rank swaps/inserts, bounded feed/page inputs, safe URL
  schemes, title entities, missing/deleted items and jobs.
- Database integration coverage uses an isolated staging schema. It checks
  concurrent acquisition, unchanged-row suppression, unauthorized and stale
  fencing, incomplete-snapshot rollback, atomic ranks, prepared handoff,
  takeover after expiry and the absolute invocation deadline.
- Real HN stories render on the server, then update through Neon Realtime.
  Two tabs received score/count changes and feed changes. The explicit sort
  preserves source rank after snapshots. Query-capability renewal was observed
  beyond the initial expiry.
- Pause freezes IDs/ranks/scores/counts while ages continue advancing. Resume
  applies current data. Comment counts now open local discussions; replies,
  submissions, votes and profiles have canonical HN destinations. Deployed More navigation showed 30 unique rows
  with ranks 31–60. Keyboard Space toggles pause/resume and highlighting; Tab
  reaches the HN vote link with a visible focus outline.
- Desktop appearance was compared with current HN. The deployed mobile page
  was checked at 390 × 844: its page and document widths are 390px, header and
  titles wrap, and there is no horizontal overflow.
- The production artifact contains traced Postgres runtime dependencies and
  bundled Neon server code. Browser assets were scanned against the actual
  database credentials and sealing secret without finding either. Credentials,
  resource responses, toolchains and build artifacts are ignored by Git.
- Package audit reported zero known vulnerabilities after replacing the full
  Firebase distribution with its app/database packages.

## Live discussions and header update

The October 12 follow-up is deployed as
`hackernews-realtime-rmj3p34a0-samwillis-projects.vercel.app`, with the stable
production alias above. Branding is Hacker Realtime, with a 22×22px RT mark
and square RT favicon. Header navigation is top/new/submit. Pause, highlight,
Realtime connection and upstream health controls are inside the orange header.

- A new frozen install in the previously verified clean checkout passed the
  TypeScript check, ten unit tests, and the pinned Vercel production build.
  npm audit reported zero vulnerabilities. All 26 public build assets passed
  a scan against the actual database credentials and sealing secret.
- New unit coverage checks independent number pulses, retention/expiry during
  overlapping updates, arrivals/moves/removals, safe HN comment formatting,
  bounded/cyclic trees, nested order and strict story IDs.
- The isolated database test passed with comments added: unchanged snapshots
  write zero rows; edits/removals and deletion placeholders publish correctly;
  an invalid tree rolls back feed and comment changes; unauthorized publication
  fails under the same fencing checks.
- The real-source local handoff test passed with a watched discussion. The
  successor warmed the tree, retained comments and reported healthy after
  promotion. Handoff-to-promotion measured 106ms in that run.
- The staging migration and updated native ingester were applied. A real story
  loaded 162 nested comment rows over Neon Realtime, then grew to 165 while the
  local page remained open. Both story and comment query capabilities renewed
  without browser errors. Production SSR and live connections were verified
  through the stable alias; comment/reply links point to the original HN item.
- `/dev/updates` provides development-only buttons for deterministic animation
  checks. It requires HN_FIXTURE=1 and returns 404 in production. Browser checks
  found only a score span or comment-count span pulsing after their respective
  updates, with no structural row highlight. New rows had intermediate height
  and opacity during expansion; reordered rows had intermediate translateY and
  background values. The same checks passed for edited/inserted/reordered
  comments. Collapsing a parent hid its descendants and expanding restored them.
- In the deployed thread, keyboard pause kept all 169 comment IDs/commit markers
  unchanged while upstream comments continued arriving. Resume applied 173 rows
  with zero field pulses or structural highlights. Native scheduled transfers at
  20:24, 20:26 and 20:28 UTC promoted in approximately 157, 33 and 11ms while the
  discussion was watched; no source/session/watch failure events were recorded.
- The production mobile discussion was checked at 390×844: document and page
  widths both measured 390px, RT measured 22×22px, the header controls wrapped,
  and nested replies remained readable. Keyboard Space toggled pause.

The demo currently watches three distinct discussions at once, with up to 500
comments per thread. Watches expire 90 seconds after their last renewal. Busy
threads retry, showing cached rows and an explicit upstream-busy indicator.
Large discussions link to the complete original HN thread. These bounds have
functional coverage; broader discussion-load measurement remains outstanding.
The earlier launch checks below continue to apply, including deployed reduced
motion and injected failures.

## Event timeline

The fixed event footer replaces the old HN links/search footer on feeds and
story discussions. The update is deployed as
`hackernews-realtime-7lhlt98e3-samwillis-projects.vercel.app` with the stable alias
above. [Timeline screenshot](timeline.png) shows event details and both colours.

- TypeScript, 13 unit checks and two isolated staging database tests passed.
  Journal coverage includes every changed field, no-op suppression, feed moves
  and exits, comment insert/edit/remove, transaction rollback and retention.
  A 1,500-event unit burst retained every event across different types and IDs.
- Migration 0003 was applied on the dedicated staging branch. Row triggers record
  domain events in the same fenced transaction; the unchanged native ingester
  produces them automatically. A separate sealed Realtime query receives events
  independently of the current page and thread. There is no event-type filter
  or result-count cap; ingestion prunes journal records older than 15 minutes.
- Deterministic browser checks showed all 30 events orange while rows crossed
  the viewport during a reversal, then 15 orange after the 320ms animation
  settled. Scrolling changed the orange/grey distribution while the footer
  stayed at the same screen position. An exiting comment retained orange during
  its grace period. Collapsing a parent made its edited reply's event grey.
- Pause kept timeline counts and every marker position unchanged while an
  offscreen event arrived. Resume included it. Click/focus opened complete burst
  details and Escape closed them. Inspection holds the timeline steady; an
  outside tap and close button also dismiss the panel.
- Production received score/count/rank events for stories outside the current
  page, plus watched-discussion events. A live discussion rendered 195 comments
  with both source and Realtime healthy. The mobile page was checked at 390×844:
  document/footer widths were 390px and the detail panel stayed within the
  viewport (12px–378px). The normal desktop viewport was restored afterwards.
- The pinned Vercel production build passed. All 26 public assets passed a scan
  against the actual database credentials and sealing secret before upload.

“All events” covers changes mirrored by the demo's first 150 top/new stories and
bounded watched discussions. The timeline displays the most recent two minutes;
events in the same second share a counted marker whose details list every event.
Text/body details use short, plain-text excerpts. Broader launch checks below,
including deployed reduced motion, are still open.

## Ingestion evidence

The deployed configuration uses 120,000ms active tenure, 90,000ms standby
preparation, a 240,000ms absolute request budget, 5s heartbeat and 20s lease
expiry. Observed native scheduled requests completed after roughly 120–181s.
This proves the shorter configuration works; the scheduler's full 15-minute
caller timeout has not been established.

In the 19:32–19:47 UTC observation window there were 51 changed transactions,
400 changed item records and 2,563 changed feed entries. Transaction receipt
diagnostics had p95 292ms, p99 748ms and maximum 748ms. Each transaction uses
the oldest available receipt among its changed items/feeds. The commit marker
is recorded just before COMMIT; these are approximate diagnostics, not a fully
correlated per-event acceptance distribution.

Six scheduled handoff-to-promotion observations in that window measured
23, 104, 151, 113, 235 and 182ms. One session at 19:40 UTC had no prepared
standby, retired, and ingestion resumed on a fresh delivery at 19:42 UTC.
The implementation now waits for a late successor while continuing to publish
within its remaining absolute budget. An isolated real-source regression probe
passed: the worker stayed active past its planned tenure, then handed off in
106ms. The delayed successor reported healthy ingestion after 5,952ms, including
its source connection and readiness preparation.

Local Node workers using real HN and isolated staging schemas were forcibly
terminated with SIGKILL. Prepared-standby recovery took 18,037ms. Cold recovery,
including a deliberate 60s scheduler-phase delay, took 64,578ms. These passed
the 120s target, but are not remote Neon isolate termination measurements.

After the ingestion update, native scheduled handoffs at 19:52, 19:54 and 19:56
UTC reached promotion within approximately 0, 182 and 110ms. No failure events
were recorded from 19:51 through the final 19:57:53 check. The final deployed
page stayed live beyond capability renewal and through the 19:56 handoff.

Two deployed tabs collected 133 item-application samples: 121 on top and 12 on
new, representing 131 distinct `(item_id, committed_at)` updates. Every distinct
update correlated to a recorded ingestion transaction (14 transactions).
Browser p95/p99 and maximum were 65ms; correlated transaction receipt diagnostics
had maximum 321ms. Collection began at 19:48:46 UTC, and the top tab's pause and
resume window was excluded. The final web artifact was observed from 19:54:47.
These timings use clocks and commit markers rather than an exact COMMIT
acknowledgment or browser paint marker. Rank-only changes do not update the
item commit marker, and new-row insertions are not included in these samples.

Ignored raw evidence lives in `.local/clean-build-result.json`,
`.local/recovery-results.json`, `.local/handoff-results.json` and
`.local/ingest-measurements.json`, `.local/browser-measurements.json` and
`.local/final-validation.json`. Reproduce the probes with the commands in the README;
the probes remove their isolated test schemas.

## Persistent connection and navigation

The navigation follow-up is deployed as
`hackernews-realtime-5id3bvty8-samwillis-projects.vercel.app`, with the same stable
production alias. A single root-layout client now owns page subscriptions and
the persistent event timeline. Internal navigation prepares destination queries
before committing the route, reusing those handles and their authoritative rows.

- TypeScript, 19 unit tests and the pinned Vercel production build passed.
  New tests cover baseline readiness, handle reuse, warm back navigation,
  bounded idle cleanup, timeouts and terminal errors, capability renewal,
  invalid-renewal failure reporting, query identity and rapid navigation.
- The deployed top → new → top → discussion → browser-back flow kept the
  connection live. Pause and highlighting survived page changes; the single
  footer retained its timeline. The real discussion displayed 198 comments.
  Browser logs contained no warnings or errors during these checks.
- Local pagination showed rank 31 on page two and stayed live on browser back.
  Rapid top/new clicks respected the latest choice. At 390×844, feed switching
  stayed live, one footer remained, and document width stayed 390px.
- Direct HTTP responses from production contained 30 feed rows and rendered
  discussion comments before JavaScript. Both pages remain dynamic Next App
  Router server-rendered routes; browser subscriptions start during hydration
  or destination preparation.
- All 26 public production assets passed the credential/sealing-secret scan.
  The proof image is [navigation.png](navigation.png).

## Launch checks still required

- Extend correlated latency measurements to inserts, removals and rank-only
  changes, using exact commit/browser-application markers. The 131-item update
  sample meets the count target but does not establish every event type in the
  plan's complete p95/p99 acceptance gate.
- Force termination in the deployed Neon runtime and verify cold/warm recovery
  there. Local-process results support the lease design but leave the remote
  shutdown lifecycle unverified.
- Inject upstream and Realtime connection interruptions; verify stale reporting,
  reconnect/reset and authoritative recovery under failure.
- Extend the short final soak to cover scheduler delays over a longer period.
  A missed handoff during the earlier observation remains recorded above.
- Exercise reduced motion in the deployed UI. The media-query behavior is
  implemented, but the manual check is incomplete.

The staging demo can be explored now. These checks must pass before calling it
launch ready under the plan's acceptance targets.
