# Neon staging setup notes

These notes summarize the user-supplied `NEON_REALTIME_SETUP.md`, dated
2026-10-09, and the local Realtime examples. They are setup reference for the
implementation; no staging resources have been provisioned for this repository.

## Environment

Set both hosts when running the Neon CLI against staging:

```sh
export NEON_API_HOST=https://console-stage.neon.build/api/v2
export NEON_OAUTH_HOST=https://oauth2-stage.neon.build
```

Use `neon --profile staging ...` for the staging credential profile. The profile
selects credentials; it does not change the API or OAuth host.

Reuse existing staging authentication when available. If authentication is
missing, sign in against staging with both host variables set. Choose the
organization at provisioning time; do not assume the example organization in
the supplied guide is the intended owner of this demo.

## Project requirements

- Create a dedicated demo project in a staging organization. The supplied guide
  reports a zero project limit for personal staging accounts.
- Use PostgreSQL 18 and `aws-us-east-2`, the region tested in the supplied guide.
- Confirm Functions, scheduled Function Triggers, and Realtime are available
  together for that organization and region.
- Enable logical replication before starting ingestion. The examples warn that
  this restarts computes and cannot be reversed.
- Allow the exact local and deployed browser origins when enabling Realtime.

## Prerelease tooling

Build the required packages from the Neon packages checkout and the appropriate
CLI PR refs. Record the exact refs and build commands in the repository when
implementation begins. The supplied guide describes older placeholder npm
packages, while the local examples reference `0.0.1`; verify package contents
instead of treating either version number as proof of a usable release.

Keep generated tarballs in `.sdk/`, which is gitignored. Scripts should accept
`NEON_PKGS_DIR` and document how another developer can reproduce the packages.

The guide also describes a fallback using `neon api` to call the Realtime
management routes when the installed CLI lacks first-class support. Recheck the
current routes before using that fallback.

## Secrets and URLs

- Use `.env.local` for application secrets. Preserve existing custom variables
  when pulling Neon-managed values.
- Use the pooled database URL for ordinary application traffic and the direct
  URL for schema setup.
- Keep `NEON_REALTIME_SECRET` server-only. It can seal arbitrary queries.
- Convert the Realtime HTTPS `invocation_url` to `wss://` for the SDK, without
  adding a path suffix. The SDK supplies the required WebSocket subprotocol.
- Publish only the WebSocket URL as `NEXT_PUBLIC_NEON_REALTIME_URL`.
- Neon Functions inject their branch's database URLs at runtime; avoid copying
  the application database credentials into Function deployment configuration.
- Write raw project-creation responses under `.local/` if needed: they can
  contain database passwords and must never be committed.

## References

- User-supplied setup guide: `NEON_REALTIME_SETUP.md` (2026-10-09).
- Local examples: `neon-examples/realtime`, particularly `nextjs`.
- SDK and CLI source: `neon-pkgs`.
- [Realtime preview docs](https://neon-next-git-thruflo-realtime-3-integration-neondatabase.vercel.app/docs/realtime/)
- [Function runtime limits](https://neon.com/docs/compute/functions/reference/runtime-limits)
- [Function Triggers](https://neon.com/docs/compute/functions/triggers/overview)
