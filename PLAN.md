# Realtime Hacker News — draft implementation plan

Status: draft. Prepared 2026-10-12.

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

- Match the standard HN page: orange header and Y logo, beige background,
  Verdana typography, compact numbered rows, grey metadata, familiar navigation,
  and the usual More link. Check the current site at desktop and mobile sizes
  before implementing the layout. Keep Neon Realtime attribution in the footer.
- Top and new feeds, 30 rows per page. Start by tracking the first 150 items of
  each feed; their union bounds upstream subscriptions and database work.
- Use the source feed order for ranking. Support jobs and missing optional
  story fields without broken rows.
- Update scores and comment counts in place; use subtle, brief highlights for
  changed values and new stories. Animate rank changes with reduced-motion support.
- Place a small control row below the standard header: live/pause, a toggle
  for highlighting changes, and a compact connection/freshness indicator.
  Match the surrounding HN type size and spacing.
- Pause freezes the displayed list while the live subscription continues.
  Resuming shows the latest state without replaying every animation.
- Show connection state and source freshness separately so an active Realtime
  connection does not hide a stalled ingester.
- Link comments/discuss, user profiles, voting, login, and Submit to the real
  HN site. HN owns those interactions and their authentication.

### Navigation and interaction destinations

Preserve standard labels and ordinary link behavior, including opening a link
in another tab. The live comment count remains the discussion link label.

| Element | Destination |
| --- | --- |
| Y logo / Hacker News title | This demo's top feed. |
| New | This demo's new feed. |
| Story title | The original article URL; `https://news.ycombinator.com/item?id={id}` for a text post or missing article URL. |
| Comments / discuss / story age | `https://news.ycombinator.com/item?id={id}`. Users read and comment on the original thread. |
| Submit | `https://news.ycombinator.com/submit`. |
| Author | `https://news.ycombinator.com/user?id={username}`. |
| Vote arrow | The original HN item page, where HN handles voting for signed-in users. |
| Login | `https://news.ycombinator.com/login`. |
| Other standard header links | Their real HN pages until a matching feed is implemented locally. |

URL-encode IDs, usernames, and any query parameters when constructing links.

### Follow-up work

Add locally mirrored Ask/Show/Jobs feeds and optional Algolia search. Keep
discussion and submission links pointing to the real HN site.

## Application architecture

Use Next.js, React, TypeScript, and Drizzle, adapting the local `realtime/nextjs`
example. The application server reads initial rows from Postgres and seals
fixed, parameterized feed queries. The browser uses a shared Realtime client,
`RealtimeProvider`, and `useLiveQuery` with `initialData` and `refreshQuery`.

The browser's story data comes from Neon. A separate Neon Function mirrors HN
into the same branch's database. Host the Next.js application on a platform
that supports its Node server, with Vercel as the initial deployment choice.

Use bounded, validated feed and page parameters in the sealing endpoint. The
Realtime secret remains server-only. The ingester accepts verified Function
Trigger deliveries, using the SDK's trigger parser; arbitrary public requests
must not start ingestion.

## Database outline

| Table | Purpose |
| --- | --- |
| `hn_items` | HN ID as primary key; type, title, URL, author, creation time, score, descendants, deletion/dead flags, and relevant source fields. |
| `hn_feed_entries` | Composite key `(feed, item_id)` and source rank; indexed for feed pagination and joined to `hn_items`. |
| `ingest_leases` | Active owner, expiry, heartbeat, and fencing token to coordinate invocations across isolates. |
| `ingest_status` | Last successful reconciliation, source event, committed write, and latest failure for freshness reporting. |

Use primary keys and `REPLICA IDENTITY FULL` on subscribed tables. Publish feed
membership and rank changes in a transaction. Fetch missing items before
publishing their feed entries so the UI does not briefly show incomplete rows.
Update source columns only when they differ, avoiding unnecessary writes and
Realtime batches. Preserve IDs as React keys so changed ranks retain row identity.

## Ingestion design

Use a scheduled Function Trigger every minute. Each invocation attempts to
acquire a short renewable Postgres lease. If another healthy invocation owns
it, return immediately. Keep all ownership decisions in Postgres because
Functions can run multiple isolates.

The proposed active session is around 12 minutes, returning a normal response
before the runtime's 15-minute first-byte deadline. Verify the trigger caller's
own timeout before committing to this duration; it is not specified in the
docs reviewed so far. Shorten the session if required by the staging result.

Each active session:

1. Acquires the lease and refreshes the bounded top/new feed snapshots.
2. Subscribes to feed lists and tracked item nodes. Prefer Firebase's SDK so
   many item listeners share a connection; SSE remains a fallback.
3. Coalesces events into small write batches, preserving processing order.
   Applies inserts, source changes, removal flags, and feed changes to Postgres.
4. Renews ownership periodically. Every write transaction verifies the owner
   and fencing token, so an expired worker cannot publish after takeover.
5. Reconnects with backoff and refreshes authoritative state after reconnects.
6. Stops near its session deadline, flushes pending writes, removes listeners,
   and releases its lease. Handles `SIGINT` with best-effort cleanup within
   Neon's five-second shutdown window.

A later scheduled call starts the next session. There can be a handoff gap
around the scheduler cadence plus startup delay; reconciliation restores
current state. This mirrors current HN state rather than preserving every
intermediate score change. Periodic reconciliation during a session also guards
against missed upstream events. Persist progress and health, not a fabricated
HN replay cursor.

## Delivery phases

### 1. Prove the staging ingestion lifecycle

- Resolve the staging organization and a dedicated demo project. Confirm that
  Functions, scheduled triggers, and Realtime are available together.
- Build the required SDK/CLI refs from local source and record exact commits.
- Provision PG18 in `aws-us-east-2`, enable logical replication and Realtime,
  and configure local browser origins; follow [staging notes](docs/neon-staging.md).
- Deploy a minimal scheduled function. Verify outbound HN streaming, the
  caller's request duration, lease renewal, and actual scheduling while another
  invocation is active. Observe a full proposed session and the next takeover.
- Resolve any timeout limitation before implementing the longer ingestion loop.

Exit: the deployment supports a measured, restartable ingestion session and
the chosen duration is documented. Do not assume a background promise will
keep an invocation alive after its response.

### 2. Scaffold the app and database

- Add the Next.js/TypeScript app, Drizzle schema, repeatable schema setup, and
  local package-build scripts. Record prerequisite Node and package-manager
  versions and commit the dependency lockfile.
- Seed a bounded real HN snapshot and render the top/new pages from Postgres
  using the standard HN layout and canonical external interaction links.
- Add server-side sealing and the browser Realtime provider, including renewal.

Exit: the HN layout renders initial rows and committed database changes reach
two open browser tabs through Neon Realtime.

### 3. Implement shared ingestion

- Add source subscriptions, tracked-item reconciliation, batched conditional
  upserts, transactional feed updates, and lease fencing.
- Add freshness records and structured logs for starts, source events, writes,
  retries, lost leases, and shutdowns. Keep credentials out of logs.
- Handle null, deleted, dead, and incomplete items, source reconnects, duplicate
  deliveries, and clean session termination.

Exit: real HN changes appear without refreshing, overlapping calls have one
effective writer, and ingestion recovers after an interrupted session.

### 4. Polish, verify, and deploy

- Add the compact live/pause and highlighting controls, subtle row transitions,
  mobile layout, keyboard access, reduced motion, and clear stale/error states.
- Compare the demo with the current HN layout at desktop and mobile sizes,
  checking header, fonts, colors, row density, spacing, and navigation.
- Decode titles into escaped text and validate outbound URL schemes.
- Run type checking and a production build. Exercise the meaningful ingestion
  and browser checks below; add focused automated coverage for lease fencing,
  reconciliation, and feed ordering where failures would corrupt visible data.
- Deploy the application, allow its origin, and verify the deployed browser
  connects directly to the managed Realtime endpoint.
- Document local run, staging setup, package builds, deployment, and how to
  disable ingestion. Ensure preview branches do not inherit an active ingestion
  schedule unintentionally.

Exit: the deployed demo stays current across a full ingestion handoff and
Realtime capability renewal, with a reproducible setup documented.

## Acceptance checks

- Real score/count changes and source rank changes reach two open tabs.
- SSR rows appear immediately; the first live snapshot reconciles intervening
  changes. Subscriptions remain live beyond their original sealed-query expiry.
- A new feed item is complete on arrival; removed items disappear atomically
  with the appropriate feed update.
- Concurrent trigger calls cannot write under stale ownership. Restarting an
  ingester refreshes current state without duplicated items or corrupted ranks.
- An upstream interruption marks source data stale; a Realtime disconnect
  preserves the last rows and recovers to an authoritative snapshot.
- Pause/resume, pagination, mobile use, and reduced motion remain usable.
- The page retains the standard HN appearance, with extra controls confined to
  the compact control row and attribution in the footer.
- Comments/discuss and Submit lead to the real HN thread and submission form;
  article, profile, vote, and login links have the specified destinations.
- No database credentials or Realtime sealing secret enter browser assets or Git.

## Decisions to resolve during implementation

- Which staging organization should own the project, and does it have all
  required feature access?
- Which CLI PR refs and SDK commit form a working, reproducible package set?
- What timeout does scheduled trigger delivery enforce in staging?
- What ingestion handoff delay is acceptable for the launch demo?
- What application deployment domain should be allowed by Realtime?

The first phase resolves the infrastructure questions. The initial product
scope and proposed stack are defaults for implementation, subject to feedback.
