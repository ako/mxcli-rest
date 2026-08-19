# specs/ — local OpenAPI contracts

`mocklab.json` is a contract that reproduces, offline and deterministically, the
JSON shapes that decide whether a Mendix mapping works:

| Path | Shape | Why it is here |
| --- | --- | --- |
| `/forecast` | object root + nested object | the shape mxcli mappings **can** populate (FINDINGS #19) |
| `/objects` | **array** root | maps to null — the shape they **cannot** |
| `/rates` | dynamic property names (`rates.AUD`) | needs a JSLT data transformer (FINDINGS #23) |
| `/objects/{objectId}` | path parameter | reproduces the `.mpr`-corrupting defect (FINDINGS #16) offline |

## Run it

```bash
npm install -g @stoplight/prism-cli      # ~15s
prism mock -p 4010 -h 127.0.0.1 specs/mocklab.json
```

Then:

```bash
curl http://127.0.0.1:4010/rates
curl -H 'Prefer: code=404' http://127.0.0.1:4010/objects/7   # force any documented status
```

`-d` (`prism mock -d`) returns randomised data generated from the schema instead
of the `example` values — useful for checking that a mapping does not quietly
depend on one fixed payload.

## Import it into the model

The contract is a local file, so no network is involved:

```sql
create or modify rest client RestLab."MockLabApi" (OpenAPI: 'specs/mocklab.json');
```

`servers[0].url` is absolute (`http://127.0.0.1:4010`), so BaseUrl is picked up
automatically — unlike the Swagger Petstore spec, whose relative `/api/v3`
forces an explicit `BaseUrl:` (FINDINGS #15).

**Verified:** the Mendix runtime reaches the mock. `127.0.0.1` is in the
container's `http.nonProxyHosts`, so runtime→mock traffic bypasses the agent
proxy; a call from a microflow returned the contract example in ~267 ms.

---

# msgraph.json — Microsoft Graph v1.0 (subset)

```bash
prism mock -p 4020 -h 127.0.0.1 specs/msgraph.json
curl -H 'Authorization: Bearer dev-token' http://127.0.0.1:4020/me
```

Seven paths, chosen because between them they carry every Graph shape that
decides whether a Mendix mapping works:

| Path | Shape | Maps? |
| --- | --- | --- |
| `GET /me` | single object + `@odata.context` | ✅ yes — `RestLab.GraphApi.GetMe` populates `GraphUser` |
| `GET /users` | `{"@odata.context", "@odata.count", "@odata.nextLink", "value":[…]}` | ❌ `value` is a repeating element — transform instead |
| `GET /users/{userId}` | path parameter | ⚠️ never via `SEND REST REQUEST` — corrupts the `.mpr` (FINDINGS #16) |
| `GET /me/messages` | nested `from.emailAddress.address` | collection, same as `/users` |
| `GET /me/events` | `start`/`end` as `{dateTime,timeZone}` objects | collection |
| `GET /groups/{id}/members` | heterogeneous, keyed by `@odata.type` | collection |
| `POST /me/sendMail` | action returning 202, no body | — |

## Why a subset and not the official spec

The official contract
(`microsoftgraph/msgraph-metadata`, `openapi/v1.0/openapi.yaml`) is **41 MB of
YAML**. It downloads in ~1.6 s but **Prism never finished loading it within a
300 s cap** — still at "Starting Prism…" when killed. Importing it into a model
would also generate thousands of operations. Cut the handful of paths you need.

## Things the mock reproduces faithfully

- **Bearer auth.** Prism enforces the spec's `security`, so a call without
  `Authorization` gets a real **401**. mxcli's OpenAPI import warns
  `unsupported HTTP auth scheme 'bearer' (only basic is supported; set
  manually)`, and a REST client document cannot hold a *dynamic* header value
  (FINDINGS #14) — so a literal token works against the mock, while production
  wants a constant or an inline `REST CALL` with the token as an expression.
- **`$`-prefixed OData query parameters.** `$select` / `$filter` / `$top` import
  as `$$select` / `$$filter` / `$$top`, because MDL already uses `$` as the
  variable prefix. Harmless, but that is what `describe` shows.
- **Prism mounts paths at the ROOT** and ignores a base path in the server URL,
  which is why `servers[0].url` here is `http://127.0.0.1:4020` and not
  `.../v1.0`. Against the real service the base is
  `https://graph.microsoft.com/v1.0`.
