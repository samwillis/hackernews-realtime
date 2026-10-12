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
  applies current data. Comments, submissions, votes, profiles and login have
  canonical HN destinations. Deployed More navigation showed 30 unique rows
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
