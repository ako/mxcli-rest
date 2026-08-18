# RestLab

A Mendix demo and reference app that exercises **every REST client capability
mxcli can express**, against live public APIs. Built and managed with
[mxcli](https://github.com/ako/mxcli).

## What this app is for

A developer opens a page per capability, fires the call, and sees the request,
the mapped result, and the raw response side by side. It exists to test and
showcase Mendix REST client functionality — both as a working example and as a
place to reproduce REST-related mxcli behaviour.

## What it keeps track of

- **CallLog** — the spine. Every demo call writes one: url, method, status,
  duration in ms, error, timestamp.
- **RestObject** — CRUD lane against `api.restful-api.dev` (writes really persist).
- **Product** — paginated lane against `dummyjson.com`.
- **Post** / **Author** — association-mapping lane against `jsonplaceholder.typicode.com`.
- **Pet** — OpenAPI-generated lane from the Swagger Petstore spec.

A CallLog belongs to the demo that made it.

## Who logs in

- **Developer** — runs any demo, sees all call logs.
- **Administrator** — the above, plus managing stored demo data and credentials.

## Endpoints used

Each was probed from the build container on 2026-08-18; see FINDINGS.md for the
ones that were rejected and why.

| Endpoint | Showcases |
| --- | --- |
| `api.restful-api.dev/objects` | Full CRUD lifecycle — POST/PUT/DELETE genuinely persist |
| `dummyjson.com` | Auth (login → JWT → bearer), pagination (`limit`/`skip`/`total`), search |
| `petstore3.swagger.io/api/v3/openapi.json` | OpenAPI 3.0 import (`CREATE REST CLIENT (OpenAPI: '…')`) |
| `httpbingo.org` | Error handling: arbitrary status codes, basic/bearer auth, header echo, delays |
| `jsonplaceholder.typicode.com` | Response mapping onto entities, nested objects |
| `api.open-meteo.com` | Parallel-array JSON — an awkward mapping case, no API key |

## Build and run

- **Mendix version:** 11.13.0
- **Theme:** `signal`
- **mxcli:** built from source from [`ako/mxcli`](https://github.com/ako/mxcli) `main`
  — **not** the `mendixlabs/mxcli` nightly binary. There is no published binary
  for this fork, so `.claude/bootstrap-mxcli.sh` builds it (needs Go, make, a JVM
  and git; ~2–4 min cold).

```bash
./mxcli run --local --setup --ensure-db -p RestLab.mpr   # prerequisites
./mxcli run --local -p RestLab.mpr                       # boot, serves :8080
```

A fresh session self-bootstraps: the Claude Code SessionStart hook in
`.claude/settings.json` runs `.claude/bootstrap-mxcli.sh`, which rebuilds the
git-ignored `./mxcli` binary and brings the runtime and database up.
