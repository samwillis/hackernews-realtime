# Hacker Realtime — implementation plan and status

Status: implementation built and deployed; launch acceptance remains open. Prepared
2026-10-12. See [measured validation](docs/validation.md) for completed checks
and outstanding launch acceptance work.

## Goal

Match the normal Hacker News interface, adding a few discreet controls for
live updates. Stories, scores, comment counts, and feed positions update
through Neon Realtime while the page remains open. Commenting and submissions
take place on the real Hacker News site. The demo should be easy to run locally
and suitable for sharing at launch.

## Confirmed findings

- HN's official public API needs no API key and describes its data as near real
  time. Firebase supports live subscriptions to feed lists and individual items.
- A read-only 45-second SSE probe received subsequent events from `topstories`,
  `updates`, and an individual story. That story's score changed from 230 to 231.
- `topstories` and `newstories` return up to 500 ordered IDs. Item records provide
  titles, authors, URLs, scores, `descendants` comment counts, and `kids` IDs.
- `/updates` supplies changed item and profile IDs. It is not documented as a
  durable log with a replay cursor; recovery must refresh current state.
- The local Next.js example combines SSR, Drizzle, sealed queries, and React's
  `useLiveQuery`, including renewal after the initial capability expires.
- Neon Realtime supports deterministic ordered queries, limits, and joins. Keep
  age formatting in the browser rather than using `now()` in a live query.
- Functions have a 15-minute time-to-first-byte limit and a 15-minute
  `waitUntil` cap. Active response streams can last longer while bytes flow.
  Outbound HN subscriptions alone do not establish an active response stream.

Sources: the [HN API](https://github.com/HackerNews/API),
[Firebase REST reference](https://firebase.google.com/docs/reference/rest/database#section-streaming),
[Realtime preview docs](https://neon-next-git-thruflo-realtime-3-integration-neondatabase.vercel.app/docs/realtime/),
and [Function runtime limits](https://neon.com/docs/compute/functions/reference/runtime-limits).

## Demo scope

### First version

- Match the standard HN page: orange header and square RT logo, beige background,
  Verdana typography, compact numbered rows, grey metadata, top/new/submit navigation,
  and the usual More link. Check the current site at desktop and mobile sizes
  before implementing the layout. Keep Neon Realtime attribution in the footer.
- Top and new feeds, 30 rows per page. Start by tracking the first 150 items of
  each feed; their union bounds upstream subscriptions and database work.
- Use the source feed order for ranking. Support jobs and missing optional
  story fields without broken rows.
- Update scores and comment counts in place; use subtle, brief highlights for
  changed values and new stories. Animate rank changes with reduced-motion support.
- Place live/pause, a toggle for highlighting changes, and a compact
  connection/freshness indicator at the right of the orange header; wrap on mobile.
  Match the surrounding HN type size and spacing.
- Pause freezes the displayed list while the live subscription continues.
  Resuming shows the latest state without replaying every animation.
- Show connection state and source freshness separately so an active Realtime
  connection does not hide a stalled ingester.
- Open story comment counts in local live nested discussions. Reply/comment,
  profile, vote and Submit actions stay on real HN. Remove login from the header.
- Fetch uncached first comments in the server route loader and navigation preparation;
  seed the shared cache before subscribing, then render remaining comments progressively.
- Watch every open discussion on the shared Firebase connection, up to 500 comments
  per thread. Use independent viewer leases, release on departure, and expire abandoned
  watches after 30 seconds. Show loading/stale/truncated states and original links.
- Pulse only changed numbers and edited comment text. Expand arriving story/comment
  rows, animate movement with stable IDs, and suppress motion on resume or when
  reduced motion is requested. Allow comment branches to collapse.

### Navigation and interaction destinations

Preserve standard labels and ordinary link behavior, including opening a link
in another tab. The live comment count remains the discussion link label.

| Element                         | Destination                                            |
| ------------------------------- | ------------------------------------------------------ |
| RT logo / Hacker Realtime title | This demo's top feed.                                  |
| Top / New                       | This demo's top / new feed.                            |
| Story title                     | Original article URL; original HN item for text posts. |
| Comments                        | Local live `/item?id={id}` thread.                     |
| Story / comment age             | Original HN item.                                      |
| Comment / reply                 | Original HN item / reply page.                         |
| Submit                          | `https://news.ycombinator.com/submit`.                 |
| Author                          | Original HN profile.                                   |
| Vote arrow                      | Original HN item, where HN handles voting.             |

URL-encode IDs, usernames, and any query parameters when constructing links.

### Follow-up work

Add locally mirrored Ask/Show/Jobs feeds and optional Algolia search. Keep
reply and submission links pointing to the real HN site.

## Application architecture

Use Next.js, React, TypeScript, and Drizzle, adapting the local `realtime/nextjs`
example. The application server reads initial rows from Postgres and seals
fixed, parameterized feed queries. The browser uses a shared Realtime client,
`RealtimeProvider`, and `useLiveQuery` with `initialData` and `refreshQuery`.

Every feed result includes `item_id` and source `rank`. Use
`ORDER BY rank ASC, item_id ASC` with the page limit/offset to select membership
on the server. Sort a copy of the returned rows by the same keys before
rendering SSR data and every live snapshot, including updates, resets,
reconnects, and resume from pause. The current SDK materializes rows in a Map;
its array order does not reposition an existing row when its rank changes.
Apply each complete batch before sorting and use `item_id` as the React key.

The browser's story data comes from Neon. A separate Neon Function mirrors HN
into the same branch's database. Host the Next.js application on a platform
that supports its Node server, with Vercel as the initial deployment choice.

Use a prebuilt Vercel deployment for the initial demo. A clean checkout must
fetch the pinned Neon sources and generate `.sdk/` packages before application
dependency installation, then build and upload the complete application
artifact. [Prerelease build and deployment](docs/prerelease-build.md) specifies
the pipeline, package integrity checks, and deployment environment handling.

Use bounded, validated feed and page parameters in the sealing endpoint. The
Realtime secret remains server-only. The ingester accepts verified Function
Trigger deliveries, using the SDK's trigger parser; arbitrary public requests
must not start ingestion.

## Database outline

| Table             | Purpose                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hn_items`        | HN ID as primary key; type, title, URL, author, creation time, score, descendants, deletion/dead flags, and relevant source fields.                             |
| `hn_feed_entries` | Composite key `(feed, item_id)` and source rank; indexed for feed pagination and joined to `hn_items`.                                                          |
| `ingest_leases`   | Separate active/standby slots; owner, expiry, heartbeat, planned session end, readiness, and an active fencing token to coordinate invocations across isolates. |
| `ingest_status`   | Last healthy connection check, successful reconciliation, source event, committed write, latest failure, and handoff/recovery timings for freshness reporting.  |

Use primary keys and `REPLICA IDENTITY FULL` on subscribed tables. Publish feed
membership and rank changes in a transaction. Fetch missing items before
publishing their feed entries so the UI does not briefly show incomplete rows.
Update source columns only when they differ, avoiding unnecessary writes and
Realtime batches. Preserve IDs as React keys so changed ranks retain row identity.

The discussion tables are `hn_threads` (cache load ownership, health and truncation),
`hn_thread_views` (per-page viewer leases and release tombstones) and `hn_comments`
(composite story/item key, parent, deterministic path/depth, text and deletion/dead
state). Self-post text is stored on `hn_items.body`. Cold page loads claim a short
per-thread lease without holding a connection over HN requests, then seed initial
comments only if the worker has not populated the cache. A row lock serializes
seeding with worker publication. Incomplete snapshots only add missing rows;
complete worker snapshots conditionally update and delete in the globally fenced
transaction. Thread queries order by path then item ID, including both composite
key columns. Feed readiness permits handoff independently of cold discussions;
cached rows survive the successor's partial tree until reconciliation completes.

## Ingestion design

Use a scheduled Function Trigger every minute. With no active owner, an
invocation acquires the active Postgres lease and begins reconciliation. Most
calls return immediately while that owner is healthy. During the final two
minutes of its planned session, one call reserves the standby slot, connects
to HN, and prepares current feed/item snapshots. Further calls return while
that standby slot is occupied. Only the active owner publishes feed writes.
Keep all ownership decisions in Postgres because Functions can run multiple
isolates.

The implemented active session is two minutes, with a 90-second preparation
window and a four-minute absolute request budget. Native scheduled deliveries
completed after 120–181 seconds. The trigger caller's full fifteen-minute
timeout remains unverified; the demo uses the shorter measured configuration.
Both roles must finish their requests within the caller
limit. Record an absolute request deadline on arrival, including standby
preparation time and a cleanup margin. Promotion never resets that deadline;
the new active tenure is capped by the invocation's remaining budget. If the
caller limit is shorter, choose a shorter active session and preparation window
that still allow overlapping scheduled invocations to meet the handoff budget.
If no measured configuration meets the budgets below, the ingestion gate
fails: record the limitation and propose a supported alternative before
declaring the live demo ready. UI work can continue independently.

Lease settings: renew every 5 seconds with a 20-second expiry. Verify
the owner, unexpired lease, and fencing token under a row lock in every feed
write transaction. A failed renewal stops publication and aborts pending work.
Treat these settings as values to verify in the lifecycle probe.

Each active session:

1. Acquires its role's lease and refreshes the bounded top/new feed snapshots.
2. Subscribes to feed lists and tracked item nodes. Prefer Firebase's SDK so
   many item listeners share a connection; SSE remains a fallback.
3. Coalesces events into small write batches, preserving processing order.
   Applies inserts, source changes, removal flags, and feed changes to Postgres.
4. Renews ownership periodically. A standby stays read-only for feed data and
   marks itself ready once the current tracked set has initial values and its
   source connection is healthy. Every feed write verifies active ownership and
   fencing, so an expired worker cannot publish after takeover.
5. Reconnects with backoff and refreshes authoritative state after reconnects.
6. Near its session deadline, flushes accepted batches and atomically transfers
   active ownership to a ready standby, incrementing the fencing token. The
   promoted invocation detects ownership promptly, reconciles current source
   values, and starts writing. Discard superseded queued snapshots rather than
   replaying an old owner's backlog. The retiring invocation removes listeners
   and completes its response. Handle `SIGINT` with best-effort cleanup within
   Neon's five-second shutdown window.

Poll ownership every 250 ms while a standby is ready for transfer. Keep the
number of source sessions bounded to one active plus one standby. If the
active owner dies, a prepared standby can take over after lease expiry;
otherwise a subsequent scheduled call performs cold recovery. If no standby
is ready at the request deadline, stop cleanly, report degraded ingestion, and
recover on a later call; that run fails the planned-handoff acceptance check.

This mirrors current HN state rather than preserving every intermediate score
change. Reconcile at least every 60 seconds and after reconnects or ownership
changes. Persist progress and health, not a fabricated HN replay cursor. A
quiet but connected source is healthy: freshness must use successful connection
checks/reconciliation rather than the time of the last changed story alone.

### Measured demo budgets

These are implementation acceptance targets, not platform guarantees. Measure
with correlated events/transaction IDs and synchronized clocks; include feed
membership and rank changes as well as score/count updates.

| Measurement                                                                                  | Acceptance target                                                                                                            |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| HN event received by the active ingester to database commit                                  | p95 <= 2 seconds; p99 <= 5 seconds.                                                                                          |
| Committed change to sorted rows applied in an unpaused browser                               | p95 <= 2 seconds; p99 <= 5 seconds.                                                                                          |
| Planned ownership handoff, from old owner stopping publication to new owner ready to publish | <= 5 seconds for every observed handoff.                                                                                     |
| Forced active-worker termination to reconciled ingestion restored                            | <= 120 seconds.                                                                                                              |
| Source health reporting                                                                      | Mark degraded within 30 seconds of failed checks or loss of ownership; show an explicit reconnect immediately when detected. |

HN's delay before publishing an API event is outside these measurements. Record
the source-received, committed, and browser-applied times separately. Validate
at least three planned handoffs, cold and warm forced recovery, and 100 observed
source changes across two tabs. Use isolated test records when controlled
events are needed; do not fabricate scores in the mirrored HN data. A missed
budget blocks launch until corrected or explicitly revised with the user.

## Delivery phases

### 1. Build the UI and prove staging in parallel

Begin the UI track immediately; it does not depend on a provisioned database
or a successful scheduled-function probe.

- **UI track:** scaffold Next.js with public framework dependencies and a
  representative local story fixture. Match the current HN desktop/mobile
  layout, external interaction links, pagination, and compact controls. Keep
  fixture mode explicit and development-only. Exercise rank swaps and inserted
  rows against the same sorting function planned for live snapshots.
- **Toolchain track:** resolve the SDK/CLI refs, pin exact commits, and implement
  the bootstrap/packing pipeline before adding local SDK dependencies. Verify
  it can install and build from a clean checkout using the lockfile, with no
  pre-existing `.sdk/` packages or local Neon checkout.
- **Staging track:** resolve the organization and dedicated demo project;
  confirm Functions, scheduled triggers, and Realtime are available together.
  Provision PG18 in `aws-us-east-2`, enable logical replication and Realtime,
  and allow local origins; follow [staging notes](docs/neon-staging.md).
- Deploy a minimal lifecycle probe with the lease schema and source
  subscriptions. Measure the trigger caller's timeout, outbound streaming,
  standby readiness, fencing, scheduled overlap, planned takeover, and forced
  termination recovery. Keep reusable schema/probe code for later phases.

Exit: the HN UI runs independently; prerelease packages reproduce from a clean
checkout; and the staging probe has demonstrated a supported session duration,
three handoffs within 5 seconds, and recovery within 120 seconds. If the staging
gate fails, continue UI/toolchain work while recording and resolving the
ingestion limitation. Do not rely on an untracked background promise after
returning the Function response.

### 2. Connect the app, database, and live queries

- Extend the Next.js/TypeScript scaffold, Drizzle schema, repeatable schema
  setup, and local package-build scripts from phase 1.
  Record prerequisite Node and package-manager versions and commit the
  dependency lockfile.
- Seed a bounded real HN snapshot and render the top/new pages from Postgres
  using the standard HN layout and canonical external interaction links.
- Add server-side sealing and the browser Realtime provider, including renewal
  and explicit sorting of projected ranks after every snapshot.

Exit: the HN layout renders initial rows and committed database changes reach
two open browser tabs through Neon Realtime.

### 3. Implement shared ingestion

- Add source subscriptions, tracked-item reconciliation, batched conditional
  upserts, transactional feed updates, lease fencing, and the warm-standby
  handoff proven in phase 1.
- Add freshness records and structured logs for starts, source events, writes,
  retries, lost leases, and shutdowns. Keep credentials out of logs.
- Handle null, deleted, dead, and incomplete items, source reconnects, duplicate
  deliveries, and clean session termination.

Exit: real HN changes appear without refreshing, overlapping calls have one
effective writer, planned handoffs meet the 5-second budget, and forced
recovery meets the 120-second budget. Measure the normal ingestion/browser
latency targets under the bounded two-feed workload.

### 4. Polish, verify, and deploy

- Add the compact live/pause and highlighting controls, subtle row transitions,
  mobile layout, keyboard access, reduced motion, and clear stale/error states.
- Compare the demo with the current HN layout at desktop and mobile sizes,
  checking header, fonts, colors, row density, spacing, and navigation.
- Decode titles into escaped text and validate outbound URL schemes.
- Run type checking and a production build. Exercise the meaningful ingestion
  and browser checks below; add focused automated coverage for lease fencing,
  reconciliation, and feed ordering where failures would corrupt visible data.
- From a clean checkout, generate pinned SDK packages before dependency
  installation and run the prebuilt Vercel deployment pipeline. Verify the
  server has its runtime dependencies, the correct server-only environment,
  and the browser-visible URL baked into the build.
- Allow the deployed origin and verify the browser connects directly to the
  managed Realtime endpoint. Use the same artifact pipeline for subsequent
  builds while packages remain unpublished.
- Document local run, staging setup, package builds, deployment, and how to
  disable ingestion. Ensure preview branches do not inherit an active ingestion
  schedule unintentionally.

Exit: the deployed demo stays current across a full ingestion handoff and
Realtime capability renewal, meets the measured budgets across the required
samples, and has a reproducible clean-checkout build/deployment documented.

## Acceptance checks

- Real score/count changes and source rank changes reach two open tabs.
- Changing a row's rank reorders it correctly without changing its React key.
  Rank swaps, inserted rows, page-boundary changes, resets, reconnects, and
  resume from pause all use the explicit `(rank, item_id)` ordering.
- SSR rows appear immediately; the first live snapshot reconciles intervening
  changes. Subscriptions remain live beyond their original sealed-query expiry.
- A new feed item is complete on arrival; removed items disappear atomically
  with the appropriate feed update.
- Concurrent trigger calls cannot write under stale ownership. Restarting an
  ingester refreshes current state without duplicated items or corrupted ranks.
- Three planned handoffs and both cold/warm recovery scenarios meet the stated
  budgets; normal event-to-commit and commit-to-browser timings meet the p95/p99
  targets across at least 100 observed source changes.
- An upstream interruption marks source data stale; a Realtime disconnect
  preserves the last rows and recovers to an authoritative snapshot.
- Pause/resume, pagination, mobile use, and reduced motion remain usable.
- The page retains the standard HN appearance, with extra controls confined to
  the orange header and attribution in the footer.
- Comment counts open local live nested threads. Comment/reply and Submit
  lead to the original HN discussion and submission form; article, profile
  and vote links have the specified destinations.
- No database credentials or Realtime sealing secret enter browser assets or Git.
- A fresh checkout with empty `.sdk/`, `.local/`, and `node_modules/` can generate
  identical pinned package artifacts, install with the frozen lockfile, build,
  and deploy the prebuilt application without the developer's local checkout.

## Implementation decisions

- Sam's staging organization owns the dedicated `square-paper-24289554` project.
  Functions, schedules, Realtime and PG18 work together on its main branch.
- Neon commit `3c08c9b45a919515a7b79977fa6267f828ce52d5` includes the merged CLI
  Realtime support. `neon-toolchain.lock.json` pins its build and artifact hashes.
- Two-minute active sessions, 90-second preparation and a four-minute request
  budget are deployed. Publication continues while a delayed successor is
  awaited, up to that same absolute deadline. Fifteen-minute scheduled requests
  remain unverified.
- Vercel hosts [the demo](https://hackernews-realtime.vercel.app/); its stable
  origin and configured preview origins are allowed by Realtime.
- Build and deployment passed. The exact completed measurements and remaining
  launch gates are recorded in [validation](docs/validation.md).
