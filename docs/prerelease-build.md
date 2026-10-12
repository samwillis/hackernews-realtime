# Prerelease package build and deployment

Use Node 22.23.2 and npm 10.9.8. `neon-toolchain.lock.json` pins Neon source
commit `3c08c9b45a919515a7b79977fa6267f828ce52d5`, pnpm 10.30.3, SDK artifacts and
Vercel CLI 48.10.10. The installed native Vercel CLI 62.2.0 failed to load its
builder during this build; the pinned Node CLI succeeds.

## Build from a checkout

```sh
npm run bootstrap
npm ci
npm run typecheck
npm test
npm run build
```

Bootstrap clones into `.local/toolchains/neon-pkgs`, installs its frozen
lockfile, builds the required packages and CLI, and creates `.sdk/*.tgz`.
Runtime workspace dependencies are resolved to the matching sibling versions;
all required siblings are direct local dependencies of the app. Application
installation uses its committed lockfile.

Neon's declaration bundler produces nondeterministic source-map encodings.
Packing removes optional source maps and their references while preserving
runtime JavaScript and declarations. SHA512 artifact checks match both the
toolchain manifest and the application lockfile. A mismatched package aborts
bootstrap. `NEON_PKGS_DIR` is accepted only for a clean checkout at the exact
pinned commit. A fresh clone with no SDK artifacts or dependencies passed the
full build; run `npm run test:clean` to reproduce that check.

For an intentional source update, update the pinned commit, run
`node scripts/bootstrap.mjs --update-integrity`, regenerate the application
lockfile from the new artifacts, and rerun the clean-build check. Do not use
the integrity-update switch in routine builds.

## Prebuilt Vercel deployment

```sh
npx --yes vercel@48.10.10 link --yes --project hackernews-realtime
node scripts/vercel-env.mjs preview
npx --yes vercel@48.10.10 pull --yes --environment=preview
node scripts/hydrate-build-env.mjs preview
npx --yes vercel@48.10.10 build --yes
npx --yes vercel@48.10.10 deploy --prebuilt --target preview
```

The environment setup script uses installed Vercel CLI 62 for its API and
credential commands; deployment uses the pinned version above. Vercel stores
server values as secrets that cannot be pulled back. The
environment setup script feeds credentials via stdin and uses the Vercel API
to store the validated public WebSocket URL as plain configuration. After
pulling, the hydration script replaces build placeholders in the ignored
`.vercel/.env.preview.local` with the corresponding values from `.env.local`.
Never commit either file. Configure the public URL before
the build; Next embeds it in browser assets. Server credentials remain runtime
environment variables supplied by Vercel.

Add the resulting exact browser origin to `DEMO_ORIGIN` and run
`npm run ingest:deploy` to update Realtime's allowed origins. For subsequent
preview URLs, preserve all origins still in use in `DEMO_ADDITIONAL_ORIGINS`.
Use an explicit deployment target: Vercel can promote a project's first default
deployment to production even when the command omits `--prod`.

The shared demo is deployed at
[hackernews-realtime.vercel.app](https://hackernews-realtime.vercel.app/).
For a production artifact, run:

```sh
node scripts/vercel-env.mjs production
npx --yes vercel@48.10.10 pull --yes --environment=production
node scripts/hydrate-build-env.mjs production
npx --yes vercel@48.10.10 build --prod --yes
npx --yes vercel@48.10.10 deploy --prebuilt --prod
```

Run this in a checkout whose pinned bootstrap, frozen install and checks have
passed. The clean-build script reports its artifact directory in
`.local/clean-build-result.json`; copy only the ignored `.env.local` and Vercel
project link into that directory before preparing deployment configuration.

The prebuilt artifact contains traced server dependencies and bundled Neon
server code. The deployment does not install missing ignored SDK tarballs.
`.vercelignore` excludes local toolchains and credentials. Browser assets were
checked against the actual sealing secret and database password before upload.

The Neon Function deploys separately with `npm run ingest:deploy`. The policy
keeps schedules disabled; that wrapper explicitly enables the named shared
project/branch only when `ENABLE_INGEST=1`.
