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
