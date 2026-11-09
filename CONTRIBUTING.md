# Contributing to Yept

Small, focused contributions are welcome. Read the [README](README.md) for setup, current capabilities and limits, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before changing code

For a bug, open an issue with the app version, operating system, expected and actual behaviour, and a minimal synthetic reproduction. For a substantial feature or dependency change, discuss the problem in an issue before implementing it. A suggestion is not a commitment to ship it.

Use the [security policy](SECURITY.md) for vulnerabilities. Do not post security details or credentials in a public issue.

## Set up and work

Use the README's source-build steps, then create a feature branch:

```sh
git switch -c your-change
npm run dev
```

Run commands at the repository root. The root manifest controls Electron builds and npm workspaces. See [architecture](docs/architecture.md) before moving code between `packages/core`, `packages/ui` and `apps/desktop`.

- Keep the change focused and match surrounding naming, idioms and comment density.
- Keep Electron imports within `apps/desktop/src/host`. Shared engine and UI code use the existing API and host boundaries.
- Add a regression test when behaviour changes; do not add tests that only repeat implementation details. Documentation and image-only changes do not need new unit tests.
- Use permissive dependencies only, with exact versions. Do not introduce native modules, telemetry or unsolicited network activity.
- Keep local notes and private design discussions out of committed files. Repository documentation must stand on its own.
- Use a Git name and email you intend to publish. Follow the existing commit style and omit attribution trailers.

## Keep examples synthetic

Use `fixtures/collections` and the local fixture server. Examples should use names such as Alex Example and URLs such as `https://api.example.test`. Never submit real collections, customer or supplier information, internal hostnames, work addresses, credentials or local secret files.

Screenshots must use an isolated test profile and synthetic workspace. Inspect every image for paths, account details, tokens and response content before adding it. Copy only the intended images into `docs/images`; test output stays ignored under `e2e/out`.

## Validate the change

```sh
npm run typecheck
npm test
npm run check:licenses
npm run e2e
```

Report the commands actually run, pass/fail counts, skipped checks and any failures in the pull request. If script-sandbox tests fail on timing under load, rerun once and report both runs. Never describe an unrun check as passed. See [testing](docs/testing.md) for focused suites and optional prerequisites.

For packaging changes, build on the target operating system, run the packaged application's `--self-test`, and check About against that package. macOS packaging requires a Mac. Keep unsigned and experimental status explicit.

After changing dependencies, review upstream terms and update [licence source records](build/licenses/README.md) where necessary. Do not bypass a failing licence check or invent a missing copyright notice.

## Pull requests

Explain the problem, resulting behaviour and validation. Include before/after screenshots for visible changes. Separate verified results from anything still untested. Avoid unrelated formatting changes and generated build output.

Keep `out/`, `dist/`, generated third-party notices, local profiles and test screenshots out of commits. The build regenerates the notices. Contributions to project code are under the [MIT licence](LICENSE); retain upstream licences and copyright notices when including third-party material.
