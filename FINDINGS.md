# FINDINGS

Durable notes for the next session. Append, don't rewrite.

**Versions:** Mendix 11.13.0 · mxcli built from `ako/mxcli` main @ `6833c37`
(`mxcli --version` reports `6833c37 (2026-08-18T14:22:53Z)`) · Go 1.24.7 ·
OpenJDK 21.0.10 · ANTLR 4.13.2 via antlr4-tools 0.2.2.

---

## 1. `mxcli init` silently overwrites `.claude/bootstrap-mxcli.sh`

**Impact: high** — it reverts the bootstrap script to downloading the
`mendixlabs/mxcli` **nightly** binary, which for a fork-tracking project is the
wrong binary entirely, and the revert is not reported in the command's output.

- **Seen:** rewrote the script to build from `ako/mxcli` main, then ran the
  prescribed idempotency check `./mxcli init --tool claude`. The rewrite was
  gone; `grep -c MXCLI_REPO` returned 0. `init` prints "Added SessionStart hook
  to .claude/settings.json" whether or not it clobbered a customised script.
- **Workaround:** order matters — run `mxcli init` **first**, patch the script
  **after**. If you must re-run `init`, restore the script from git afterwards.
- **Verified:** `cmd/mxcli/init_hook.go:25` (`bootstrapScriptName`) writes it
  unconditionally. The hook's own `./mxcli init --sync-skills .` is **safe**:
  `cmd/mxcli/init.go:143` returns before the hook-writing step. So a session
  start does not clobber it; only a bare `init` does.

## 2. Building `ako/mxcli` main from source

`go install …@latest` does not work (generated ANTLR parser is not committed),
and this fork publishes no binaries — so building is the only option.

- `make grammar` needs an `antlr4` launcher **and a JVM**, not just Go:
  `pip install --break-system-packages 'antlr4-tools==0.2.2'` then
  `export ANTLR4_TOOLS_ANTLR_VERSION=4.13.2`. On first run it downloads the
  pinned jar from `antlr.org`, so it needs network too.
- Use `make build`, not a bare `go build`. `make build` = `grammar` +
  `sync-all` + `completions`, and `sync-all` embeds the skills/commands that
  `mxcli init` later installs — a bare `go build` yields a binary that writes
  no skills.
- Cost: ~92 s for `make build` on a warm module cache; 88 MB binary.
- `mxcli version` is **not** a command (errors with `unknown command`). It is
  `mxcli --version`.

## 3. `mxcli new` hardlinks the binary into the project

`RestLab/mxcli` is a hardlink to the `./mxcli` you invoked ("shared inode, no
copy"), so `mv` refuses it as the same file. `rm -f RestLab/mxcli` before
moving the project up to the repo root, as the provisioning steps say. The
generated `.claude/bootstrap-mxcli.sh` correctly named `RestLab.mpr` after the
move — no fixup needed there.

## 4. The Mendix runtime JVM can reach the internet here

The one environmental risk for a REST-focused app, and it is fine. This
container sets `JAVA_TOOL_OPTIONS` globally with `-Dhttps.proxyHost=127.0.0.1
-Dhttps.proxyPort=42023`, the proxy CA truststore
(`/root/.ccr/java-truststore.p12`), and an `http.nonProxyHosts` list that
excludes `localhost|127.0.0.1|…` — so runtime→Postgres and admin-port traffic
correctly bypass the proxy while outbound HTTPS goes through it. Direct
unproxied egress **also** works (`curl --noproxy '*'` → 200), so calls succeed
either way. No app-side proxy configuration needed.

## 5. Endpoint probe results (2026-08-18)

Probed from this container before choosing demo targets. Several
widely-recommended APIs are dead or changed:

| Endpoint | Result | Note |
| --- | --- | --- |
| `api.restful-api.dev/objects` | ✅ 200 | Writes **really persist** — POST → GET → DELETE round-trip verified |
| `dummyjson.com` | ✅ 200 | `POST /auth/login` returns a real JWT; `limit`/`skip`/`total` pagination |
| `petstore3.swagger.io` | ⚠️ spec 200, writes broken | `POST /pet` → **500**; a GET on the id I chose returned *someone else's* pet (`nua-demo-pet`). Shared mutable state, id collisions. Good for OpenAPI import, unusable as a write target |
| `httpbingo.org` | ✅ 200 | Maintained Go port of httpbin; `/status/418`→418, basic-auth→200, bearer→authenticated |
| `jsonplaceholder.typicode.com` | ✅ 200 | Writes are **faked** — returns 201 with your body echoed, nothing persists |
| `httpbin.org` | ❌ 503 | Public instance chronically down; use `httpbingo.org` |
| `reqres.in` | ❌ 401 | Now requires a real API key; the old free `reqres-free-v1` key is rejected with `missing_api_key` |
| `api.github.com` | ❌ 403 | Blocked by this container's agent proxy |
| `api.open-meteo.com`, `pokeapi.co`, `fakestoreapi.com`, `api.zippopotam.us` | ✅ 200 | |
| `restcountries.com/v3.1`, `openlibrary.org` | ✅ 301/302 | Need redirect following |

## 6. mxcli offers three distinct REST client mechanisms

Worth knowing before modelling, since they take different inputs:

1. `CREATE REST CLIENT <M>.<Name> (BaseUrl:…, authentication:…) { operation … }`
   — the Mendix 11 Consumed REST Service document. Path/query params, static and
   dynamic headers, JSON/FILE body, timeout, and
   `Response: mapping <Entity> { Attr = json_field }` onto a real entity.
2. `CREATE REST CLIENT (OpenAPI: '<url>')` — generates the whole client from an
   OpenAPI 3.0 spec, storing the spec in the document for Studio Pro parity.
   `DESCRIBE CONTRACT OPERATION FROM OPENAPI '<url>'` previews without writing.
3. `REST CALL GET/POST … RETURNS String` inside a microflow — the classic Call
   REST activity, with `ON ERROR WITHOUT ROLLBACK` for fallbacks.

Response kinds: `json as $x`, `string as $x`, `file as $x`, `status as $x`,
`none`, and `mapping <Entity> { … }`. Upstream regression examples note issue
#843 (response mappings silently dropped) as fixed and verified on 11.13.0 —
worth re-confirming here, since this app leans on that path heavily.

## 7. `operation` blocks inside `create rest client` are NOT comma-separated

Easy to get wrong, because the property list just above them (`BaseUrl:`,
`authentication:`) *is* comma-separated, and so are the clauses **inside** an
operation (`method:`, `path:`, `response:`).

```sql
-- wrong
operation A { ... },
operation B { ... }
-- right
operation A { ... }
operation B { ... }
```

- **Seen:** `mxcli check` on a 6-client draft →
  `extraneous input ',' expecting {DOC_COMMENT, OPERATION, '}'}` at each
  separator. The message names the expected tokens, so it is quick to diagnose.
- **Verified:** removing the separating commas → `✓ Syntax OK (30 statements)`.

## 8. `mxcli check <script>` is syntax-only

It parses and reports statement count; it does not resolve names, so a script
that references a non-existent entity or an unimplemented mapping shape still
passes. Treat a green `check` as "the grammar accepts this", not "this will
execute" — and confirm with a real `mx check` after `exec`.

---

# Findings from building the model

## 9. Inline REST response mappings can only target String attributes (CE6099)

**Impact: high.** This is the one that cost the most time, and it is invisible
until a real `mx check`.

An inline `Response: mapping <Entity> { Attr = jsonField }` writes every JSON
element with schema type **String** — `sdk/mpr/writer_rest.go` hardcodes
`{"$Type": "DataTypes$StringType"}` (and `XmlPrimitiveType: "String"`) in the
value mapping element, and the MDL grammar for a mapping entry is just
`identifierOrKeyword EQUALS identifierOrKeyword`, so there is **no syntax to
declare the element's type**.

Mapping such an element onto an Integer, Decimal or Boolean attribute therefore
produces, per attribute:

```
[error] [CE6099] "Schema data type 'String' is not compatible with attribute
'RestLab.Product.Price' of type 'Decimal'." at Value mapping element 'price'
```

- **Seen:** a domain model with natural types (Integer ids, Decimal prices,
  Boolean flags) plus mappings for 4 lanes → **16 errors** from `mx check`.
  `mxcli check` passed (`✓ Syntax OK`) and `mxcli exec` reported success with no
  warning at all.
- **Workaround:** every attribute populated *directly* by a REST response
  mapping must be `String`. Keep a separately-named typed attribute alongside it
  and parse in the microflow when a real type is needed (`Product.Price` String
  → `Product.PriceValue` Decimal).
- **Verified:** after converting the mapped attributes to String, the same
  mappings give 0 CE6099. See the note at the top of `mdlsource/01-domain-model.mdl`.

## 10. `autoowner` / `autocreateddate` + `read *` ⇒ CE0066, with no way out

**Impact: high**, because every part of it looks correct in isolation.

An entity with audit members (`Owner: autoowner`, `CreatedDate: autocreateddate`)
granted with `read *, write *` fails the build with:

```
[error] [CE0066] "Entity access is out of date. Please update security by
clicking the 'Update security' button in the domain model editor."
```

`grant … (read *, write *)` does not store a `*`; it stores an **explicit
per-member list** (visible via `show access on <Entity>`) which **omits the audit
members**, so Mendix considers the rule stale.

Each escape route is closed:

- Listing the members explicitly — `read (…, "Owner", "CreatedDate")` — is
  rejected by mxcli's own lint rule **MDL-SEC01**: *"gives the audit member Owner
  per-member rights — Mendix stores no member access for audit members, and a
  rule that carries one fails the build with CE0066"*, advising `read *`, which
  is what fails.
- `UPDATE SECURITY IN RestLab` prints **"All entity access rules are up to
  date"** while `mx check` reports CE0066 on the very same model.
- Re-running the grants does not help *while the audit members exist*.

- **Workaround:** do not use audit members on an entity you grant with `read *`.
  RestLab.CallLog uses a plain `Timestamp: DateTime` set by the microflow.
- **Verified:** dropping `Owner`/`CreatedDate` and re-running the same grants
  took the model to **0 errors**. Re-running the grants *before* dropping them
  did not.

## 11. Entity access goes stale whenever members change

Related but distinct from #10, and worth knowing on its own: adding an attribute
or association after a `grant` leaves the stored member list incomplete, and
`mx check` reports CE0066. **Re-run the grant script after any domain-model
change.** In this project that means `mxcli exec mdlsource/02-security.mdl`
after every `01-domain-model.mdl` run — which is why both scripts are written to
be idempotent (`create or modify …`, `create or modify user role`).

## 12. `millisecondsBetween()` returns **Decimal**

Assigning it to a `Long` (or `Integer`) variable fails with
`[CE0117] "Error(s) in expression."`, which does not say which side is wrong.

- **Verified** by exec'ing two otherwise-identical microflows with differently
  named result variables — `PROBE_Decimal` passed, `PROBE_Long` failed. (Naming
  both result variables `Ms` first made the error ambiguous, since `mx check`
  identifies the activity by variable name: "Change variable Ms".)
- `CallLog.DurationMs` is therefore `Decimal`.

## 13. `SHOW ACCESS ON ENTITY <Mod.Entity>` does not parse

The grammar (`MDLCatalog.g4`) defines `SHOW ACCESS ON qualifiedName` plus
MICROFLOW / PAGE / WORKFLOW / NANOFLOW variants — but **no ENTITY variant**. So
`ENTITY` is consumed as the qualified name and the statement dies on the dot:

```
Parse error: line 1:29 extraneous input '.' expecting the start of a statement
```

The correct form is the bare `show access on RestLab.Product;`. Note the
project's own generated `CLAUDE.md` documents the unsupported form
(`SHOW ACCESS ON MICROFLOW|PAGE|ENTITY Mod.Name`).

## 14. Dynamic header values are prefix-only (by design, but silent)

`headers: ('Authorization' = $bearer)` silently stores `''`. This is
**intentional** — `cmd_rest_clients.go` comments that Mendix consumed REST
services cannot hold a dynamic header value, so only the static prefix is
stored and the value must come from the calling microflow. Written as
`'Authorization' = 'Bearer ' + $bearer` the prefix `'Bearer '` is stored, which
is the form to use. Nothing warns when the prefix is empty.

## 15. OpenAPI import needs an explicit BaseUrl when `servers[0].url` is relative

The Swagger Petstore spec declares `servers: [{url: "/api/v3"}]`. mxcli warns
clearly and continues:

```
Warning: server URL "/api/v3" is relative and cannot be used as BaseUrl;
set BaseUrl explicitly in CREATE REST CLIENT
```

...but the resulting client has no BaseUrl and is unusable, so treat this
warning as an error. Passing `BaseUrl:` alongside `OpenAPI:` resolves it.
19 operations imported cleanly after that. (A second warning, `operation
uploadFile: non-JSON request body; set body type manually`, is expected —
multipart bodies are not derived.)

## 16. PATH parameters on `SEND REST REQUEST` write an invalid BSON type and make the .mpr UNLOADABLE

**Impact: critical.** This does not produce an error — it produces a project
that Studio Pro and mxbuild cannot open at all.

```sql
$Obj = send rest request RestLab.CrudApi.GetObject with ($objectId = '7');
```

`mxcli check` passes, `mxcli exec` reports "Created microflow", and then:

```
ERROR: System.AggregateException: One or more errors occurred.
(The type cache does not contain a type with qualified name Microflows$ParameterMapping.)
 ---> Mendix.Modeler.Storage.Caches.TypeCacheUnknownTypeException
```

`mx check` never reaches the checking stage — it dies in `StreamingBsonUnitReader`
while *loading* the model. There is no error list, just a stack trace.

**Root cause.** Both writers emit the BSON `$Type` `Microflows$ParameterMapping`
for a REST operation's path-parameter mappings:

- `mdl/backend/modelsdk/microflow_rest_write.go:44` (and its
  `RegisterListMarker` at line 15)
- `sdk/mpr/writer_microflow_actions.go:882`

That type **does not exist in the Mendix metamodel**. mxcli's own generated
`generated/metamodel/types.go` lists the real ones — including
`Microflows$RestOperationParameterMapping` and `Microflows$RestParameterMapping`
— and `Microflows$ParameterMapping` is not among them. The adjacent query-
parameter code in the same functions correctly emits
`Microflows$QueryParameterMapping`, which is why query parameters are fine.

**Scope, established by bisection** on an otherwise clean model (0 errors),
one microflow at a time:

| Microflow | `with (...)` | `mx check` |
| --- | --- | --- |
| `T_QueryOnly` — `CatalogApi.GetProducts with ($limit, $skip)` | query params | **0 errors** |
| `T_PathOnly` — `CrudApi.GetObject with ($objectId)` | path param | **unloadable** |

**Workaround:** never pass a path parameter to `SEND REST REQUEST`. Call such
operations with an inline `REST CALL '…/{1}' with ({1} = $Value)` instead. The
cost is that the REST client document's response mapping is bypassed, so you get
raw JSON and must map it yourself. `RestLab.ACT_Crud_GetObject` is written this
way and says so.

**Recovery:** `git checkout -- <App>.mpr mprcontents/ && git clean -fd mprcontents/`.
Committing a known-good model before each risky exec is what made this
recoverable — `mxcli exec` applies statements one at a time and cannot roll back.

## 17. A mapped array response yields ONE object, not a list

`send rest request` against an operation whose response mapping has an entity
root returns a **single object even when the JSON root is an array**:

```
[error] [CE0100] "'Objects' is of type RestLab.RestObject, but should be of
type List." at Loop
```

So `LOOP $O IN $Objects` is invalid for `GET /objects` and `GET /posts`. To
iterate the children of a mapped envelope, go through the association instead —
`RETRIEVE $Products FROM $ProductList/RestLab.ProductList_Product` — which is
what the catalog lane does.

## 18. Do NOT quote identifiers inside microflow EXPRESSIONS

The project's `CLAUDE.md` says to always quote identifiers. That is right for
*declarations*, but microflow expressions and member references are free text
handed to Mendix, and the quotes are passed through literally and rejected:

- `Lane = RestLab."Lane"."Crud"` → `[CE0117] "Error(s) in expression."`
- `CHANGE $O ("RestLab.RestObject_CallLog" = $Log)` →
  `[CE1060] "Association 'RestLab.RestObject_CallLog' cannot be changed,
  because the entity is not found."`
- `$Product/"Price"`, `$PL/RestLab."ProductList_Product"` — same class of problem

Unquoted (`RestLab.Lane.Crud`, `RestLab.RestObject_CallLog`, `$Product/Price`)
all pass. Note CE0117 does not say *which* sub-expression is wrong, and it is
reported per activity, so a shared helper called from 8 places produces 8
identical messages.
