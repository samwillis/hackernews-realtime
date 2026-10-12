# Prerelease build and deployment plan

Status: implementation requirements. The application, bootstrap script, and
toolchain manifest will be created in the delivery phases in [PLAN.md](../PLAN.md).

## Chosen deployment path

Use a prebuilt Vercel deployment while Neon SDK/CLI support is unpublished.
Generate the required packages locally or in CI, install the application,
produce Vercel's complete output artifact, then upload that artifact. The
deployment host receives installed/traced runtime dependencies and built
assets; it does not need an ignored `.sdk/` directory from the Git checkout.

Keep `.sdk/`, downloaded source checkouts, and `.vercel/` output gitignored.
Enable Git-triggered deployment only when its pipeline performs the same
bootstrap before dependency installation, or after adopting verified published
packages.

## Reproducible package bootstrap

Create a committed `neon-toolchain.lock.json` containing exact SDK/CLI source
repositories and commit SHAs, Node and package-manager versions, required
packages, artifact filenames, and expected package integrity hashes. Include
the transitive workspace packages needed by the app and ingester. Branch names
and mutable PR refs are discovery inputs; record the resolved commits for builds.

The bootstrap script must work before app dependency installation, using the
pinned Node runtime and the source repository's pinned package manager:

1. Fetch the recorded commits into `.local/toolchains/`. Accept `NEON_PKGS_DIR`
   as an optional local override only when it matches the pinned, clean source.
2. Install the source workspace with its frozen lockfile and build the required
   packages plus their dependency closure.
3. Pack distribution files into `.sdk/`, resolving internal workspace ranges
   to the matching package versions and making all required local packages
   available to the consuming project. Keep source-only build scripts out of
   the packed application dependencies.
4. Verify artifact integrity against the toolchain manifest and the consuming
   project's dependency lockfile. Repeated builds must produce identical
   artifacts; fail on a mismatch rather than silently changing the lockfile.
5. Run the application's frozen dependency installation only after its local
   tarballs exist. Use the same artifacts when bundling the Neon Function.

An intentional source update regenerates the toolchain manifest, package
integrity values, and application lockfile together, followed by the clean
build check. A usable published release can later replace the file dependencies.

## Application build and upload

After bootstrap and dependency installation:

1. Link/pull the intended Vercel project and environment with its CLI.
2. Configure the matching server-only database URLs and sealing secret. Set
   `NEXT_PUBLIC_NEON_REALTIME_URL` before building; it is embedded in browser
   assets. Keep secrets in gitignored local/CI settings and Vercel's server
   environment, and verify none enter client assets.
3. Run type checking and `vercel build` for a preview artifact. Production uses
   the matching environment and `vercel build --prod`.
4. Upload with `vercel deploy --prebuilt`; use `--prod` only with an artifact
   built for the production environment. Verify the selected environment's
   server variables are available to the deployed Next.js handlers.
5. Allow the deployed browser origin in Neon Realtime and verify SSR, sealing,
   renewal, sorting, and two-tab updates on the deployed URL.

Use Vercel's build-output path for the full Next.js app, including server
functions and their traced dependencies. Confirm the traced output contains
the prerelease server packages. Deploy the ingester separately using the pinned
Neon CLI against staging.

## Clean-checkout acceptance

Start with no `.sdk/`, downloaded toolchain sources, or `node_modules/`. The
committed manifest and lockfiles must be sufficient to bootstrap, verify
identical package integrity, install, and build using the documented runtime.
Deploy that prebuilt output and confirm both SSR and live behavior work. This
check blocks deployment readiness while prerelease dependencies are in use.
