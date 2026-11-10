# Running collections in CI

Yept saves collections as Bruno OpenCollection YAML, so Bruno's own command-line runner, `bru` from the `@usebruno/cli` package, can run the same requests and tests in CI. Yept does not ship a CLI of its own.

Everything on this page was checked with **`@usebruno/cli` 4.3.0** on Windows 11 (Git Bash and PowerShell) against the local fixture server. Other versions may behave differently, so pin the version in CI.

## Install

Bruno's CLI needs Node.js. Install it on the CI machine, not as a dependency of your collections repository:

```bash
npm install --global @usebruno/cli@4.3.0
bru --version
```

npm may warn that it blocked an install script for `protobufjs`. Plain HTTP runs work without it.

## Run a collection

`bru` must be started from the collection folder, the one that holds `opencollection.yml`. From anywhere else it stops with *You can run only at the root of a collection*.

To try it locally, start the fixture API (`npm run fixture-server`, port 4010) and put the fixture's synthetic client secret (`CLIENT_SECRET` in `fixtures/server/server.mjs`) in an environment variable called `CLIENT_SECRET`. Then:

```bash
cd fixtures/collections/sample-travel
bru run --env local --env-var "clientSecret=$CLIENT_SECRET"
```

In PowerShell:

```powershell
cd fixtures\collections\sample-travel
bru run --env local --env-var "clientSecret=$env:CLIENT_SECRET"
```

- **Whole collection:** `bru run` with no path runs every folder, in the same order as Yept's tree (`seq`).
- **One folder:** `bru run Auth --env local ...`
- **Folders and requests in a set order:** `bru run Auth "Bookings/List bookings.yml" --env local ...` runs them in the order given. A request that needs a token from an earlier request fails if you leave the login out or put it later.
- **Environment:** `--env local` takes the file name in `environments/` without `.yml`. Yept names the file after the environment, so this is usually the name you see in Yept.
- **Stop at the first failure:** `--bail`.
- **Exit code:** 0 when every request, test and assertion passes, 1 otherwise, so the CI step fails on its own.

## Passing secrets

Yept keeps secret values on your computer (local secrets), never in the collection. A secret variable is saved in the environment file with its name only. The CLI cannot read Yept's local secrets, so give each secret to the run yourself.

Use `--env-var name=value` once per secret, with the value coming from a CI secret through an environment variable:

```bash
bru run --env local --env-var "clientSecret=$CLIENT_SECRET"
```

- Values may contain `=`; only the first `=` splits name and value.
- If a secret is not passed, the CLI sends an empty value. In the sample collection the login then gets 401 and the tests fail, which is what you want in CI.
- `--env-file` does not help here: it is merged under `--env`, and the empty secret row in `environments/local.yml` wins over the file's value.
- `{{process.env.NAME}}` also works in the CLI, from real environment variables or a `.env` file in the collection folder. Yept reads `process.env` only from that `.env` file. Keep `.env` out of Git if you use it.

Don't write secrets into the collection or environment files to make CI pass.

## Reports

```bash
bru run --env local --env-var "clientSecret=$CLIENT_SECRET" \
  --reporter-junit "$RUNNER_TEMP/bruno/results.xml" \
  --reporter-html "$RUNNER_TEMP/bruno/results.html" \
  --reporter-skip-response-body
```

`--reporter-json` writes the raw results too. Write reports outside the collection folder so they are never committed.

What the reports contain:

- **JUnit:** request names, test and assertion names and failure messages only. No headers or bodies.
- **JSON and HTML:** every request and response with headers and bodies. The HTML file embeds the same data, and loads its page script from unpkg.com, so it needs internet access to open.
- **Masked by the CLI:** `Authorization` header values (`Bearer ********`, `Basic ********`), values of variables marked secret in the environment (also when passed with `--env-var`), and values from the collection's `.env` file.
- **Not masked:** tokens the run picks up on the way. A login response body with `access_token` and an OAuth2 token sent as a query parameter appear in full in JSON and HTML reports.

So for CI, use `--reporter-skip-response-body` (or `--reporter-skip-body`) when a response carries a token, and prefer the `Authorization` header over a query parameter for tokens. With those, the checked reports had no client secret, password or token in them. `--reporter-skip-headers "X-Api-Key"` leaves another sensitive request header out of the report.

## GitHub Actions example

This runs the synthetic sample collection against the fixture API. Save the fixture's synthetic client secret as a repository secret called `TRAVEL_CLIENT_SECRET`. For your own collections, replace the fixture step with your API's address in the environment file.

```yaml
name: API checks

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  bruno:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - name: Check out source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Set up Node
        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: '24'

      - name: Install Bruno CLI
        run: npm install --global @usebruno/cli@4.3.0

      - name: Start fixture API
        run: |
          node fixtures/server/server.mjs 4010 > "$RUNNER_TEMP/fixture.log" 2>&1 &
          for i in $(seq 1 20); do curl -fs http://localhost:4010/auth/stats > /dev/null && exit 0; sleep 1; done
          exit 1

      - name: Run collection
        working-directory: fixtures/collections/sample-travel
        env:
          CLIENT_SECRET: ${{ secrets.TRAVEL_CLIENT_SECRET }}
        run: |
          mkdir -p "$RUNNER_TEMP/bruno"
          bru run --env local --env-var "clientSecret=$CLIENT_SECRET" \
            --reporter-junit "$RUNNER_TEMP/bruno/results.xml" \
            --reporter-html "$RUNNER_TEMP/bruno/results.html" \
            --reporter-skip-response-body

      - name: Keep reports
        if: ${{ always() }}
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: bruno-reports
          path: ${{ runner.temp }}/bruno/
          retention-days: 7
```

The secret goes through `env:` and not straight into the command, so its value is never part of the script text. GitHub also hides it in the log.

## What works the same as in Yept

Checked with the sample collection and with a scratch collection saved in Yept's format:

- Requests send; folder and request order follows `seq`.
- Collection, folder and request variables resolve, and a request variable wins over folder, environment and collection, as in Yept.
- Environments load with `--env`.
- Collection headers and pre-request scripts, request pre-request and post-response scripts, `bru.setVar` across requests, tests and assertions.
- Post-response variables (for example `accessToken` from `res.body.access_token`).
- `bru.sendRequest` in a script.
- OAuth2 client credentials on the collection (inherited by requests) and on a request, with the client credentials in a Basic header or in the body, and the token in the `Authorization` header or a query parameter.
- Multipart bodies with text fields and files saved as paths relative to the collection folder.
- Cookies: a cookie from one response is sent on later requests in the same run, including across a redirect. `bru.cookies` is available in scripts.

## Known differences

- **Unresolved variables are sent.** Yept stops a send that has an unresolved `{{variable}}` and lists the names. The CLI sends the text as it is, for example `?x={{notDefinedAnywhere}}`, or fails with a DNS error when `{{baseUrl}}` is missing. Write tests that would catch this.
- **No local secrets, overrides or TLS settings.** Pass secrets with `--env-var`. For a private CA or a self-signed certificate the CLI has its own `--cacert` and `--insecure` options; these were not checked here.
- **Script changes can be written to files.** `bru.setEnvVar` in the CLI writes the new value into the environment file (secret rows keep no value). In Yept it lasts for the session only. In CI this changes only the checkout, but don't commit from that job.
- **OAuth2 after a 401.** Yept fetches a new token and sends a GET once more after a 401. The CLI fails the request. The CLI also fetches one token per run and reuses it for every request with the same token URL and client.
- **Cookies start empty.** Each `bru run` starts with no cookies. Yept keeps cookies per collection and environment, and Yept's *Don't send stored cookies* setting is kept on your computer only, so the CLI ignores it.
- **Files outside the collection.** Yept keeps the path of a file outside the collection on your computer only, so the CLI can't send it. Put upload files inside the collection.
- **Masking.** Yept masks every secret and token in results, Dev tools and history. The CLI masks less (see Reports).
- **Requests Yept doesn't send.** Auth modes and body types that Yept keeps in the file but won't send (for example other OAuth2 flows or a binary file body) may be sent by the CLI.
- **User-Agent** is `bruno-runtime/4.3.0` instead of Yept's.
