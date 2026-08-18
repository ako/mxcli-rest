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
  duration in ms, success, error, raw response, timestamp.
- **WeatherReading** / **WeatherCurrent** — the open-meteo lane, and the one
  where a document response mapping really does populate entities.
- **RestObject** / **RestObjectData** — CRUD lane against `api.restful-api.dev`.
- **ProductList** / **Product** — paginated lane against `dummyjson.com`.
- **Post** / **Author** — flat-mapping lane against `jsonplaceholder.typicode.com`.
- **Pet** — OpenAPI-generated lane from the Swagger Petstore spec.

A CallLog belongs to the demo that made it.

## What actually works, and what does not

Read this before extending the app — it is the single most useful thing this
project learned, and FINDINGS.md has the evidence.

mxcli's inline REST response mappings **cannot express a repeating element**
(every `ObjectMappingElement` is written with `MaxOccurs = 1`). Nothing warns
you: `mxcli check`, `mxcli exec`, `describe` and `mx check` all pass, and the
rows are simply missing at runtime.

| Lane | JSON shape | Mapping result |
| --- | --- | --- |
| **Weather** (open-meteo) | object root + nested object | ✅ fully populated — copy this shape |
| Catalog (dummyjson) | object root + nested **array** | ⚠️ one child row, all attributes empty |
| CRUD (restful-api.dev) | **array** root | ❌ null — 0 rows |
| Blog (jsonplaceholder) | **array** root | ❌ null — 0 rows |

Two further constraints shape the code:

- **Never pass a PATH parameter to `SEND REST REQUEST`** — mxcli writes an
  invalid BSON type and the `.mpr` stops loading in Studio Pro and mxbuild
  entirely. Query parameters are fine. Operations with a path parameter are
  called with an inline `REST CALL` here.
- **Attributes populated by a response mapping must be `String`** — the mapping
  writes every JSON element as schema type String, so any other type fails
  `mx check` with CE6099. `Product.PriceValue` shows the conversion pattern.

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
| `api.open-meteo.com` | The working response mapping: object root, nested object, query parameters |

## MDL sources

The whole app is reproducible from `mdlsource/`, in order. Every script is
idempotent (`create or modify`), so the set can be re-run against an existing
model:

| Script | What it does |
| --- | --- |
| `01-domain-model.mdl` | Entities, enumeration, associations |
| `02-security.mdl` | Module roles, entity access, user roles |
| `03-rest-clients.mdl` | The five hand-written consumed REST services |
| `04-openapi-import.mdl` | PetStoreApi, generated from the OpenAPI spec |
| `05-microflows.mdl` | The lane microflows and the SUB_LogCall helper |
| `06-demo-actions.mdl` | No-argument wrappers so every button is one click |
| `07-pages.mdl` | Home_Web, Mapped_Overview, CallLog_Detail |
| `08-navigation-and-access.mdl` | Navigation profile, page and microflow access |

**Re-run `02-security.mdl` after any change to `01-domain-model.mdl`.** Entity
access rules store an explicit member list, so adding an attribute or
association leaves them stale and `mx check` reports CE0066.

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
