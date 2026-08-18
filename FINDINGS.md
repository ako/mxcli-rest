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

## 19. Inline REST response mappings cannot express a REPEATING element

**Impact: high — this is the central limitation for anyone using mxcli to
consume a REST API,** because most list endpoints are unusable through the
document mapping, and nothing reports it: `mxcli check` passes, `mxcli exec`
passes, `describe` round-trips the mapping verbatim, and `mx check` reports 0
errors. The failure only appears as missing rows at runtime.

**Root cause.** `sdk/mpr/writer_rest.go` serializes every `ObjectMappingElement`
with `{Key: "MaxOccurs", Value: int32(1)}` — hardcoded, with no MDL syntax to
say otherwise. An array can therefore never be matched.

**Measured end to end** by calling each lane from an after-startup microflow
against the live APIs and reading the tables with `psql`:

| JSON shape | Endpoint | Result in the database |
| --- | --- | --- |
| **object root + nested object** | open-meteo `/v1/forecast` | ✅ **fully populated** — `WeatherReading` (52.366 / 4.901 / GMT / 11.0) **and** the nested `WeatherCurrent` (2026-08-18T15:30, 900, 20.0) |
| object root + nested **array** | dummyjson `/products` | ⚠️ exactly **1** child row, and **every attribute empty** — 10 products requested, 1 blank `Product` written |
| **array root** | restful-api.dev `/objects` | ❌ result is **NULL** — 0 rows. An unguarded `CHANGE` on it aborts the microflow: `Change object 'Some(Objects)' should not be null` |
| **array root** | jsonplaceholder `/posts` | ❌ same — 0 rows |

Note the array-root result is neither a list (`LOOP` fails with CE0100, finding
#17) nor an object — it is null.

**Workaround:** only use a document response mapping when the JSON root is an
object and every mapped child is an object. For arrays, call the endpoint with
an inline `REST CALL … returns string` and parse the JSON yourself (a Data
Transformer / JSLT step, or an import mapping document created in Studio Pro).

RestLab is built around this: the **weather lane is the one that works**, and
the CRUD, catalog and blog lanes are deliberately left showing the broken
shapes, each with a comment saying which one it is.

## 20. Smaller things worth knowing

- **`mxcli oql` renders only some columns.** `SELECT * FROM RestLab.Product`
  returned just `PriceValue` and the ID, which reads as "the other columns do
  not exist". They do: `psql \d "restlab$product"` shows all nine, all present
  and simply NULL. Verify data with `psql` before concluding anything from an
  `oql` result. `SELECT ExternalId, Title, … ` also silently returned only
  `PriceValue`.
- **OQL keywords / non-persistent entities.** `SELECT … Limit …` fails with
  `extraneous input 'Limit' expecting 'FROM'`, and querying a non-persistent
  entity gives `Could not find column map for entity 'RestLab.ProductList'`
  (correct — it has no table, but the message does not say so).
- **An after-startup microflow must return Boolean** or deployment fails with
  `[CE0142] After startup microflow should return a boolean`. `mx check`
  reports **0 errors** on the same model — this one surfaces only at
  `mxcli run`, which exits 1 with the build JSON.
- **`parseDecimal()` throws on an empty value** at runtime rather than
  returning empty; guard with
  `if $X != empty then parseDecimal($X) else 0`.
- **Build warnings for unused request parameters.** Declaring
  `parameters: ($username: String, …)` alongside `body: template '…{username}…'`
  yields `REST request has an unused request parameter 'username'` — template
  placeholders do not bind to declared operation parameters. The same warning
  appears for the prefix-only `$bearer` header parameter of finding #14. These
  are warnings, not errors, and do not block deployment.
- **`mxcli lint` is clean of real problems** here: 0 errors, and the 81 warnings
  are convention rules (CONV006 create/delete rights, CONV007 unconstrained
  XPath, CONV010) that a demo app is expected to trip. Two are worth a look in
  real projects: `CONV011` flagged the deliberate commit-inside-loop in
  `ACT_Catalog_GetProducts`, and `SEC008` flagged `Author.Email` as
  unconstrained PII (public sample data here).

## 21. Findings from making the app actually usable

- **A blank app ships with security level OFF**, so every access rule written by
  `02-security.mdl` is inert and no demo users exist. mxcli says so clearly when
  you create one: *"project security level is Off, so the runtime creates no
  accounts and this demo user will not appear in the app. Raise it first:
  `alter project security level prototype;`"* — good message, easy to miss if
  you only read the last line of output. RestLab sets `prototype`.
- **A user role needs a System module role** once security is above Off:
  `[CE0156] "User role should have at least one System module role."` The fix is
  `create or modify user role Developer (RestLab."Developer", System.User)`.
  Note the blank app's stock `User` role carries no RestLab module role, so
  without a dedicated demo user there is no way to log in and see the app.
- **`alter enumeration … modify value X caption '…'` rejects a quoted value
  name**: `mismatched input '"Weather"' expecting IDENTIFIER`. Unquoted works.
  Another case where the project's blanket "always quote identifiers" guidance
  does not hold (see #18).
- **The generated Playwright config points at a browser that does not exist
  here.** `.playwright/cli.config.json` sets
  `executablePath: /usr/local/bin/mx-headless-shell`, which is absent in this
  container; Playwright fails with "executable doesn't exist". The working
  binary is
  `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`
  (and the `playwright` module is global, at
  `/opt/node22/lib/node_modules/playwright`, needing an absolute CommonJS
  import from a scratch `.mjs`).
- **An empty `Caption: ''` on a custom-content DataGrid column renders the
  widget name** ("colOpen") as the header, because non-attribute columns key on
  the caption. Give such columns a real caption.
- **`dynamictext` is inline**, so a title and a body placed as siblings render
  as one run-on paragraph. Wrap each in its own `container`.

## 22. End-to-end verification performed

Not just "it compiles". The following were confirmed against the running app:

1. `mx check` → **0 errors**; `mxcli lint` → 0 errors (81 convention warnings).
2. App boots, serves **HTTP 200** at `http://localhost:8080/`.
3. All six lanes made **live outbound calls** — verified in `RestLab.CallLog`
   with real status codes and durations (200s in 368–1661 ms).
4. The weather lane's response mapping **populated entities**:
   `WeatherReading` (52.366 / 4.901 / GMT / 11.0) and the nested
   `WeatherCurrent` (2026-08-18T15:30 / 900 / 20.0), read back with `psql`.
5. The **UI works**: logged in through the real login page as `demo_developer`,
   clicked "Get forecast (mapped)" and "Force a 404" on Home_Web, saw new
   CallLog rows appear in the grid, and opened the detail popup showing the raw
   response. Driven with Playwright against the running runtime.

---

# Data transformers (the answer to "can JSLT fix the awkward shapes?")

## 23. JSLT data transformers WORK; import mapping documents do NOT execute

Two halves of the same pipeline, with opposite outcomes. This matters because
the transformer is the natural answer to a payload Mendix mappings cannot
address, and it gets you most of the way — but not to entities.

### The transformer half: works, verified end to end

frankfurter.dev returns currency codes as **property names**:

```json
{"amount":1.0,"base":"EUR","date":"2026-08-18",
 "rates":{"AUD":1.6278,"BRL":6.0281,"CAD":1.606, ...}}
```

A mapping addresses fields by name, so a key only known at runtime cannot be
mapped — you would need one rule per currency. JSLT's `for (.rates)` iterates an
**object**, exposing `.key` and `.value`, which turns the property name into
data:

```
{ "base": .base, "date": .date, "amount": .amount,
  "rates": [for (.rates) {"code": .key, "value": .value}] }
```

**Verified at runtime** (`transform $Raw with RestLab.DT_RatesToList`, result
written to `CallLog.TransformedBody` and read back with `psql`):

```
{"base":"EUR","date":"2026-08-18","amount":1.0,
 "rates":[{"code":"AUD","value":1.6278},{"code":"BRL","value":6.0281},...]}
```

`create data transformer … source json … { jslt $$ … $$; }` writes correctly and
`describe` round-trips it.

### The import-mapping half: written fine, throws at runtime

`create json structure … snippet '…'` and
`create import mapping … with json structure …` both execute, round-trip
through `describe`, and give **`mx check` 0 errors**. Notably the import mapping
also accepts **Decimal** attributes with no CE6099, so it does not carry the
inline REST mapping's String-only constraint (#9).

But the mapping cannot be used:

```
com.mendix.modules.microflowengine.MicroflowException:
  key not found: Path(QName(None,),None,)
    at RestLab.ACT_Rates_GetLatest (Import with mapping : 'Import from JSON')
```

**Not specific to lists, nesting, or naming** — established by narrowing:

| Attempt | Result |
| --- | --- |
| Nested array, lowercase keys (`base`, `rates`) | `key not found: Path(QName(None,),None,)` |
| Same, with JSLT emitting PascalCase keys matching the generated `ExposedName`s (`Base`, `Rates`) | identical error |
| **Flat, two String fields, no array, no nesting** — `{"base":"EUR","date":"2026-08-18"}` into a two-attribute entity | **identical error** |

So every import mapping document mxcli writes fails the same way. The element
paths do not resolve against the JSON structure at runtime: mxcli builds
structure paths from the raw JSON key (`(Object)|base`,
`mdl/types/json_utils.go:225`) while capitalising `ExposedName`, and
`sdk/mpr/writer_import_mapping.go:104-109` falls back to
`parentPath + "|" + ExposedName` when the executor supplies no `JsonPath` —
but aligning the two by hand did not help, so the defect is deeper than the
capitalisation.

### What this means

- **Yes, a data transformer is the right tool** for dynamic property names,
  internal references, and any shape a mapping cannot address — and the JSLT
  step works today.
- **No, it does not currently rescue the mapping problem**, because the step
  that turns reshaped JSON into entities is itself broken. It is a *different*
  defect from #19 (inline REST mappings, `MaxOccurs` hardcoded to 1) and would
  have fixed #19 and #9 had it worked, since import mappings use a different
  serializer that propagates real `MaxOccurs` and real types.
- Until it is fixed, reshaped JSON can be transformed and displayed but not
  imported. RestLab's rates lane does exactly that, and keeps `IMM_Rates` and
  `JSON_Rates` in the model as the documented target shape.

**Minimal repro** for an upstream report — flat, two fields, no arrays:

```sql
create persistent entity M."E" ("Base": String(10), "RateDate": String(20));
create json structure M."S" snippet '{"base":"EUR","date":"2026-08-18"}';
create import mapping M."IMM" with json structure M."S"
{ create M."E" { Base = base, RateDate = date } };
-- then, in a microflow:
--   $O = import from mapping M."IMM" ('{"base":"EUR","date":"2026-08-18"}');
-- mx check: 0 errors. Runtime: key not found: Path(QName(None,),None,)
```

## 24. restcountries.com is no longer usable as a keyless demo endpoint

Worth recording because it is a stock recommendation in REST tutorials.

- `v3.1` (any path, with or without `?fields=`) returns HTTP 200 carrying
  `{"success":false,"data":null,"errors":[{"message":"This API version has been
  deprecated. Please visit …/legacy-api-deprecation to migrate to our new
  version (v5)."}]}`.
- **`v5` returns the same deprecation body** — `/v5/name/…`, `/v5/alpha/…`,
  `/v5/all`, `/v5/countries/…` all do. The docs page it points at shows
  "Log in" and "Get an API key", so v5 is authenticated.
- Note the failure is a **200 with an error envelope**, not a 4xx — anything
  checking only the status code will treat it as success.

It was a good suggestion on the merits: restcountries has exactly the awkward
shapes (`name.nativeName.nld.official`, `currencies.EUR.name`, `languages.nld`
— all dynamic keys). **frankfurter.dev** was substituted because it has the same
dynamic-key problem in a smaller payload and needs no key. If you have a
restcountries key, the lane transfers unchanged: only the URL and the JSLT body
differ.

For **internal references** specifically, `pokeapi.co` is live and keyless and
has the other shape worth demonstrating — arrays of objects each holding a URL
pointer (`types[].type.url`, `abilities[].ability.url`) that must be resolved or
reduced to an id. A JSLT step can pull the trailing id out of such a URL.
