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

---

# Mock servers

## 25. Prism serves an OpenAPI contract as a mock, and the whole loop works here

Verified end to end in this container, since a mock is only useful if both mxcli
and the Mendix runtime can actually reach it.

- **Install:** `npm install -g @stoplight/prism-cli` — 15 s, no Docker.
  (Docker is present but its daemon is **not usable** here, which rules out
  Microcks and the WireMock/MockServer container images; WireMock's standalone
  jar would still work, since Java 21 is available.)
- **Run:** `prism mock -p 4010 -h 127.0.0.1 specs/mocklab.json`.
- **Serves the contract's `example` values** verbatim, so payload shapes are
  deterministic — which is what makes it useful for the mapping work: the shapes
  in findings #9, #16, #19 and #23 can each be reproduced offline instead of
  depending on a public API that may deprecate itself (#24).
- **`Prefer: code=404`** forces any documented status code without editing the
  spec — a much better error-path lever than depending on httpbingo.
- **`prism mock -d`** generates randomised data from the schema instead of the
  examples, which catches mappings that quietly depend on one fixed payload.
- Unknown routes return a structured `NO_PATH_MATCHED_ERROR`, so the mock also
  validates that the client is calling what the contract says.

**mxcli import works from a local spec file** — no network:
`create or modify rest client RestLab."MockLabApi" (OpenAPI: 'specs/mocklab.json');`
→ *"Created rest client: RestLab.MockLabApi (4 operations from OpenAPI spec)"*,
with `BaseUrl` taken from the spec's absolute `servers[0].url` (contrast #15,
where Petstore's relative `/api/v3` produced no BaseUrl at all).

**The runtime reaches it**: a microflow calling `http://127.0.0.1:4010/rates`
returned the contract example in 267 ms. `127.0.0.1` is in the container's
`http.nonProxyHosts` (#4), so runtime→mock traffic bypasses the agent proxy.

The contract lives at `specs/mocklab.json`; `specs/README.md` documents it.

### Other options, and when they would beat Prism

| Tool | Use it when |
| --- | --- |
| **Prism** | You have an OpenAPI contract and want a mock in one command. Also does `proxy` mode: forward to the real API and **fail the request when the response violates the contract** — contract testing without a test suite |
| **WireMock** (standalone jar, Java 21 is here) | You need stateful scenarios, request-matching rules, latency injection, or record-and-replay against a real API. Richer than Prism, but stubs are hand-written rather than derived from the contract |
| **Microcks** | You want one place serving mocks for many contracts, plus contract testing in CI. Needs Docker — **not usable in this container** |
| **Mockoon CLI** | You want a GUI to design responses and a CLI to run them; imports OpenAPI |
| **json-server** | Quick CRUD over a JSON file when there is no contract at all — note it gives you an **array root**, which is exactly the shape mxcli mappings cannot handle (#19) |
| **Schemathesis / Dredd** | Not mocks: they test a real implementation against the contract |

Worth noting for this project specifically: mxcli's own regression example
`843-rest-response-mapping.mdl` points at `http://localhost:3001/...`, so
developing against a local mock is already the established pattern upstream.

## 26. Mocking Microsoft Graph: what maps, and what the annotations do

Graph is the integration most Mendix projects actually need, so it is worth
recording exactly where it lands against the constraints above. All verified
against a local Prism mock (`specs/msgraph.json`) driven from the running app.

**The official spec is not mockable as-is.** `openapi/v1.0/openapi.yaml` from
`microsoftgraph/msgraph-metadata` is **41 MB**; it downloads in 1.6 s but Prism
was still initialising after **300 s** and had to be killed. A 7-path hand-cut
subset loads instantly. Cut the paths you need.

**`@odata.*` annotation property names MAP FINE.** This was the open question,
and the answer is good news: `"ODataContext" = "@odata.context"` is accepted,
stored as JSON path `(Object)|@odata.context`, and **populated at runtime** —
`GET /me` produced a `GraphUser` row with
`odatacontext = https://graph.microsoft.com/v1.0/$metadata#users/$entity`
alongside `displayname`, `mail` and `jobtitle`. The constraint is on the Mendix
side, not the JSON side: the *attribute* cannot be named `Context`, which mxcli
rejects up front with `attribute 'Context' is a reserved word (CE7247)
[MDL021]` and a suggested rename.

**Graph collections still cannot be mapped.** Every list endpoint returns
`{"@odata.context":…, "@odata.count":…, "@odata.nextLink":…, "value":[…]}`, and
`value` is a repeating element — finding #19. So single-entity endpoints
(`/me`, `/users/{id}`) map through the REST client document, and collections
need the transform route.

**JSLT: use `get-key()` for annotation keys, not brackets.** Reshaping the
collection with

```
{ "count": .["@odata.count"], "nextLink": .["@odata.nextLink"],
  "users": [for (.value) {...}] }
```

produced `{"count":null,"nextLink":null,"users":[…3 real users…]}` — the array
lifted correctly while both annotations came back **null**. JSLT accepts the
bracket form and silently yields null. `get-key(., "@odata.count")` works:
`{"count":3,"nextLink":"https://graph.microsoft.com/v1.0/users?$skiptoken=RFNwdAoAAQ…"}`.
Worth knowing because the silent null looks like a mock/data problem rather
than a syntax one.

**Bearer auth is not importable.** `create rest client (OpenAPI: …)` warns
`unsupported HTTP auth scheme 'bearer' (only basic is supported; set manually)`
and imports the operations without it. Combined with #14 (a document stores only
a static header prefix, never a dynamic value), a Graph token cannot come from
the document at all. Two workable routes: a **static** header for a mock or a
constant-backed value, or an inline `REST CALL` with
`header 'Authorization' = 'Bearer ' + $Token` — which is what
`ACT_Graph_ListUsers` does, and it works.

**OData `$` parameters double up.** `$select`, `$filter`, `$top` import as
`$$select`, `$$filter`, `$$top` — MDL already uses `$` as its variable prefix.
Cosmetic, but that is what `describe rest client` re-emits.

---

# SharePoint read/write (finding #27 is the important one)

## 27. A NESTED export-mapping body makes the .mpr unloadable — one-line cause

**Impact: critical**, same class as #16: not an error message, an unopenable
project. And it bites immediately on SharePoint, because Graph requires a
nested write body: `{"fields": {"Title": ...}}`.

```sql
body: mapping RestLab."SPTask" {
  RestLab."SPTask_SPTaskFields"/RestLab."SPTaskFields" = "fields" {
    "Title" = "Title", "Status" = "Status"
  }
}
```

`mxcli check` passes, `exec` reports "Created rest client", then:

```
ERROR: System.AggregateException: One or more errors occurred.
(Export Object Mappings cannot have ObjectHandling set to 'Create')
```

**Root cause — `sdk/mpr/writer_rest.go:308`:**

```go
child := serializeInlineMappingElement(m.Entity, m.Association, m.ExposedName,
    childJsonPath, m.Children, namespace, "Create")   // <-- hardcoded
```

The ROOT is correct: `serializeRestImplicitMappingBody` passes `"Parameter"` for
an export mapping (line 272), while the response path passes `"Create"`
(line 289). Only the recursion is wrong — it hardcodes `"Create"` for every
nested child regardless of `namespace`, and Mendix rejects that on an
`ExportMappings$ObjectMappingElement`.

Omitting the optional `CREATE` keyword does **not** help — the writer never
reads it; both spellings produce the same BSON. Verified by trying each.

Suggested fix: derive the child's handling from the namespace, e.g.
`childHandling := "Create"; if namespace == "ExportMappings" { childHandling = "Parameter" }`.

- **Scope:** only NESTING breaks. A flat `body: mapping Entity { name = Name }`
  works (the CRUD lane uses one).
- **Workaround:** build the nested body with an inline `REST CALL` and a body
  template, which is what `ACT_SP_CreateTask` does.
- **Recovery:** `git checkout -- <App>.mpr mprcontents/ && git clean -fd mprcontents/`,
  then re-run the domain and security scripts.

## 28. URL and BODY placeholders are numbered independently

In an inline `REST CALL`, the `{n}` placeholders in the URL and in the body are
**separate** lists, each starting at 1. Continuing the URL's numbering into the
body gives:

```
[error] [CE0720] "Place holder index 2 is greater than 1, the number of
parameter(s)." at Call REST service activity 'Call REST (PATCH)'
```

Correct:

```sql
$r = rest call patch 'http://…/items/{1}/fields' with ( {1} = $ItemId )
  body '{{"Status": "{1}"}' with ( {1} = $Status )   -- {1} again, not {2}
```

Note also that a literal `{` in a body template is escaped by **doubling** it
(`{{` → `{`), while `}` is literal — so Graph's nested wrapper is written
`'{{"fields": {{"Title": "{1}", "Status": "{2}"}}'`.

## 29. SharePoint: what works, verified against the contract

All confirmed by driving the running app and reading both the database and
Prism's validator log.

**Read, mapped.** `GET /sites/root/lists/Tasks/items/12?$expand=fields` is an
object root with a nested `fields` object, so the document mapping populates it:

| SPTask | SPTaskFields |
| --- | --- |
| `spitemid 12`, `etag "c4f3b8a1-…,3"`, `weburl https://contoso.sharepoint.com/…` | `Replace pump seal` / `In progress` / `Adele Vance` / `2026-08-24T00:00:00Z` / `High` |

Two things this settles:

- **SharePoint's `_x0020_` internal column names map fine.**
  `"DueDate" = "Due_x0020_Date"` and `"PriorityLevel" = "Priority_x0020_Level"`
  both populate. As with `@odata.*` (#26), the awkwardness is only in the JSON
  key, which mappings address as a literal string.
- **A nested object cannot be flattened onto its parent.** `fields` has to
  become a child entity reached by an association — hence `SPTaskFields`.

**Read, collection.** `GET …/items` is the usual `@odata` + `value` envelope, so
it is transformed for display (#19), with the JSLT also renaming the `_x0020_`
columns to readable names.

**Write — and the mock proves the body was right.** The contract validates
request bodies strictly, so a wrong shape is a 422 rather than a silent pass. A
flat `{"Title":"oops"}` gets `422 Request body must NOT have additional
properties; found 'Title'`. What Mendix actually sent:

```
[5:49:24] [VALIDATOR] ✔ success  The request passed the validation rules.
[5:49:24] [NEGOTIATOR] ✔ success  Responding with the requested status code 201
[5:49:29] [VALIDATOR] ✔ success  The request passed the validation rules.
[5:49:29] [NEGOTIATOR] ✔ success  Responding with the requested status code 200
```

POST → **201**, PATCH → **200**, both after passing validation. That is a real
verdict on the JSON Mendix produced, not just "the call did not throw" — which
is the main reason to develop against a contract mock rather than a live tenant.

**Every SharePoint path is parameterised in reality**
(`/sites/{siteId}/lists/{listId}/items/{itemId}`), and a path parameter passed
to `SEND REST REQUEST` corrupts the model (#16). Two ways through, both used
here: bake the site and list into a literal operation path when they are fixed
for the app, and use an inline `REST CALL` with `{1}` templating for
item-scoped calls.

---

# Intercepting an existing app's outbound calls

## 30. Prism cannot blanket-intercept; a forward proxy can, and Mendix honours it

**Prism is per-API and requires the client to be re-pointed.** Its own CLI says
so:

- `prism mock <document>` — one document, singular positional. One spec per
  instance, mounted at the root.
- `prism proxy <document> <upstream>` — one spec, one upstream. It is a
  **reverse** proxy that validates traffic for a single API, not a forward
  proxy. `--upstream-proxy` is for *reaching* upstream through a corporate
  proxy, not for intercepting.

So mocking an existing app's calls with Prism means editing every base URL (one
Prism per API, on its own port). Fine for a greenfield app built around
constants; poor for an existing app with URLs spread through the model.

**WireMock in browser-proxy mode intercepts by hostname.** Verified:

```bash
java -jar wiremock-standalone-3.13.2.jar --port 4040 \
     --enable-browser-proxying --trust-all-proxy-targets
# register a stub for host graph.microsoft.com, url /v1.0/me, then:
curl -k -x http://127.0.0.1:4040 https://graph.microsoft.com/v1.0/me
#   -> {"@odata.context":"stubbed-by-wiremock","displayName":"Adele Vance (STUB)",...}
# same URL without the proxy reaches the real service:
#   -> {"error":{"code":"InvalidAuthenticationToken",...}}
```

**The Mendix runtime honours the JVM proxy, with no model change at all.**
This is the part that matters for an existing app. `mxcli`'s local boot
*appends* to `JAVA_TOOL_OPTIONS` rather than replacing it
(`cmd/mxcli/docker/localboot.go:226`), so:

```bash
export JAVA_TOOL_OPTIONS="$JAVA_TOOL_OPTIONS -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=4040"
./mxcli run --local -p RestLab.mpr
```

A microflow calling `http://api.frankfurter.dev/v1/latest` then received the
stub, not the real API:

```json
{"base":"EUR","date":"1999-01-01","rates":{"XXX":42.0},"note":"INTERCEPTED BY WIREMOCK"}
```

No URL edits, no constants, no redeploy of the model — the running app simply
had its egress redirected.

### The HTTPS caveat, which is the real work

The demo above is plain HTTP on purpose. For `https://` the proxy must present
a certificate the JVM trusts, and **WireMock 3.13.2 on Java 21 cannot mint one**:

```
Unable to generate a certificate authority
com.github.tomakehurst.wiremock.http.ssl.CertificateGenerationUnsupportedException:
  Your runtime does not support generating certificates at runtime
```

`GET /__admin/certs/wiremock-ca.crt` consequently returns 500. curl worked only
because `-k` skipped validation — a JVM will not. Options, in order of effort:

1. **Point the app at the mock directly** (constants / `ApplicationRootUrl`
   style config). No TLS problem at all, and the reason to keep base URLs in
   constants in the first place.
2. **mitmproxy** — purpose-built for this, generates a CA on first run; add
   `~/.mitmproxy/mitmproxy-ca-cert.pem` to the JVM truststore.
3. **WireMock with a supplied keystore** (`--https-port` + `--https-keystore`),
   or a JDK/WireMock combination where runtime cert generation works.
4. **`/etc/hosts` + a local TLS terminator** — same CA problem, more moving parts.

Importing a CA into the JVM truststore is exactly what this container already
does for its own agent proxy (`-Djavax.net.ssl.trustStore=/root/.ccr/java-truststore.p12`,
finding #4), so the pattern is proven — it is just per-tool setup:

```bash
keytool -importcert -alias mitm-ca -file ca.pem \
  -keystore $JAVA_HOME/lib/security/cacerts -storepass changeit
```

### Which tool for which job

| Goal | Tool |
| --- | --- |
| Mock **one** API you have a contract for | **Prism** — `prism mock spec.json` |
| Check a real API still matches its contract | **Prism proxy** — fails the request on violation |
| Intercept **everything** an existing app calls, by hostname | **WireMock** browser-proxying, **mitmproxy**, or **Hoverfly** |
| Record real traffic once and replay it forever | **WireMock** `--proxy-all` + `--record-mappings`, or Hoverfly capture/simulate |

---

# Organizing a module into folders

## 31. A `folder` clause only applies on CREATE; use MOVE to relocate

`create or modify microflow … folder 'Lanes/Crud'` against an **existing**
microflow creates the folder and leaves the document where it was:

```
Lanes/Crud  [0]          <- folder created, empty
  ... Microflow ACT_Demo_CrudList still listed at the module root
```

`move microflow RestLab."ACT_Demo_CrudList" to folder 'Lanes/Crud';` is what
actually relocates it. So the folder clause is fine for new documents, but a
re-organisation of an existing module has to be expressed as MOVE statements —
which is why the layout lives in its own `mdlsource/12-organize.mdl`, run last.

MOVE **is** idempotent: re-running the 35 moves reports 35 moves and no errors.

## 32. Most integration document types cannot be foldered at all

`moveStatement` (MDLParser.g4:385) accepts only:

> PAGE | MICROFLOW | SNIPPET | NANOFLOW | ENUMERATION | CONSTANT |
> DATABASE CONNECTION | JAVA ACTION | ODATA SERVICE

There is **no MOVE form, and no folder clause on create**, for:

- consumed REST services (`create rest client`)
- data transformers
- JSON structures
- import and export mappings

In RestLab that pins 8 REST clients, 3 data transformers, `JSON_Rates` and
`IMM_Rates` to the module root permanently. `show folders` does not even list
the REST clients and transformers — the root shows only `IMM_Rates`,
`JSON_Rates` and `Home_Web`, so the folder view silently under-reports what is
actually sitting at the root. Naming is the only grouping available for them
(`CrudApi`, `GraphApi`, `DT_GraphUsers`, …).

Worth raising upstream alongside the other REST findings: an integration-heavy
module is exactly the case where folders matter, and it is the one place they
cannot be used.

## 33. `drop folder` fails when the folder is absent

`drop folder 'CallLog' in RestLab;` removes an empty folder, but re-running it
gives `Error: folder not found: CallLog in RestLab`. It therefore cannot sit in
a script that is meant to be re-runnable — `12-organize.mdl` records the
statement in a comment instead of executing it, and `07-pages.mdl` was changed
to create `CallLog_Detail` in `Shared` directly so the stale folder never
appears on a fresh build.

---

# Testing ako/mxcli PR #188 and PR #189

Both branches fetched (`refs/pull/188/head`, `refs/pull/189/head`) and built from
source, then run against this project's own repros. Baseline for comparison is
the merged `main` build (`nightly-…`, the `./mxcli` in this repo).

- PR #188 = `nightly-109-g1492e57` — *reach a nested JSON leaf without an entity
  per level (#927)* + *catch a nested export-mapping member at check time
  (MDL-MAP01)*
- PR #189 = `nightly-108-gf9b816f` — *stop reporting writes that storage skipped*
  + *carry stored element $IDs onto a rewritten document*

| This project's finding | PR #188 | PR #189 |
| --- | --- | --- |
| #31 exec reports a write that did not happen | — | ✅ **fixed** |
| #27 nested export-mapping **body** → unloadable `.mpr` | ❌ still corrupts | — |
| #23 import mapping documents never execute | ❌ unchanged | ❌ unchanged |
| Nested leaf without an entity per level | ✅ **works in mapping documents**; ❌ silently wrong in an inline REST mapping | — |

## 34. PR #189 fixes the misleading write report (#31) — confirmed

Re-declaring an unchanged microflow, byte-identical to what is stored:

```
merged main :  Replaced microflow: RestLab.ACT_Demo_CrudList
PR #189     :  Unchanged microflow: RestLab.ACT_Demo_CrudList
```

This is the half of #31 that misleads. It does **not** change the underlying
behaviour — a `folder` clause on `create or modify` still does not relocate an
existing document, and MOVE is still required — but the console no longer claims
a write that storage elided. Worth having: the old output made it look as though
`12-organize.mdl` was rewriting 35 documents on every run.

## 35. PR #188's multi-segment path works in mapping DOCUMENTS…

`Attr = fields/Title` reaches a leaf below the object element without an entity
for the level in between — the thing that forced `SPTaskFields` to exist purely
to hold `fields`.

```sql
create or modify import mapping RestLab."IMM_Nested"
  with json structure RestLab."JSON_Nested"
{ create RestLab."NestedProbe" {
    ItemId = id,
    Title    = fields/Title,
    Priority = fields/Priority_x0020_Level
  } };
```

- merged main: **syntax error** — the form does not exist
- PR #188: check passes, executes, `describe` round-trips it verbatim, and
  `mx check` reports 0 errors

**Runtime could not be verified**, because #23 still blocks every import mapping
document from executing at all. So the feature is confirmed as far as the model
layer, and no further.

## 36. …but in an INLINE REST mapping the same path is silently wrong

PR #188 does not touch the inline REST client mapping — `sdk/mpr/writer_rest.go`,
`mdl/visitor/visitor_rest.go` and `mdl/executor/cmd_rest_clients.go` are all
unchanged by it. The changed files are `visitor_import_export_mapping.go` and
`cmd_import_mappings.go`, i.e. mapping **documents** only.

But the inline form still *accepts* the syntax, because a quoted
`"fields/Title"` is one QUOTED_IDENTIFIER:

```sql
response: mapping RestLab."SPFlatProbe" {
  "SPItemId" = "id",
  "Title"    = "fields/Title"
}
```

`mxcli check` passes, `exec` succeeds, `mx check` reports 0 errors, and
`describe` re-emits it. At runtime the top-level `id` populates and **every
nested value is empty**:

```
 spitemid | title | status | duedate | prioritylevel
----------+-------+--------+---------+---------------
 12       |       |        |         |
```

Cause: `writer_rest.go:308-315` builds the path as
`jsonPath + "|" + m.ExposedName`, and `ExposedName` here is the whole string
`fields/Title`, so the stored path is `(Object)|fields/Title` — one literal
member with a slash in its name — rather than the `(Object)|fields|Title` that
PR #188's own commit message documents as Mendix's storage form. Nothing
converts `/` to `|` on this code path.

**This is the same silent-failure shape as #9, #19 and #23**: every gate passes
and the data is quietly absent. It is arguably worse now, because the syntax is
about to be documented as working — a developer who reads the #927 notes will
reasonably try it in a REST client mapping and get empty columns with no
diagnostic.

Two ways out, either would do: extend the multi-segment handling to the inline
REST mapping (splitting on `/` when building `valueJsonPath`), or reject a `/`
in an inline REST mapping member with a check-time error pointing at the
document form.

## 37. PR #188 does NOT close #27 — the nested export **body** still corrupts

MDL-MAP01, added by PR #188's second commit, validates export mapping
**documents** (`mdl/executor/validate_export_mapping_members.go`). The inline
REST `body: mapping` form is a different path and is not covered:

```sql
body: mapping RestLab."SPTask" {
  RestLab."SPTask_SPTaskFields"/RestLab."SPTaskFields" = "fields" { "Title" = "Title" }
}
```

Under PR #188 this still passes check (`✓ Check passed!`), still executes
("Created rest client"), and still leaves a project mxbuild cannot load:

```
ERROR: ... (Export Object Mappings cannot have ObjectHandling set to 'Create')
```

The one-line cause in `writer_rest.go:308` (hardcoded `"Create"` for every
nested child, regardless of namespace) is untouched. Worth flagging on the PR,
since MDL-MAP01 makes it *look* addressed.

---

# Testing ako/mxcli PR #192

PR #192 is a superset: it already merges #188, #189, #190 and #191, and adds one
commit — *fix(mappings): an unauthored import range is All, not First*. Built
from source as `nightly-122-g2a9c69f` and run against this project's repros.

| Finding | Result under #192 |
| --- | --- |
| #23 import mapping documents never execute | ✅ **FIXED** |
| #19 repeating elements / #9 String-only types (via the transform route) | ✅ **unblocked** |
| PR #188 multi-segment leaf path, at runtime | ✅ **verified working** |
| #31 misleading write report | ✅ fixed (carried from #189) |
| #36 inline REST multi-segment path silently wrong | ❌ still present |
| #37 nested export **body** → unloadable `.mpr` | ❌ still present |

## 38. #23 is fixed, and it unblocks the whole transformer route

The commit quotes the exact failure this project reported —
`key not found: Path(QName(None,),None,)` — and identifies the cause: an
unauthored `import from mapping` range left both `ForceSingleOccurrence` and
`ConstantRange.SingleObject` falling back to `SingleObject`, which is Studio
Pro's *First*, not a single-object import. Only the bare form was affected;
`all`, `first` and limit/offset all set the pointers explicitly.

Its own note is worth repeating: *"the repo had no runtime coverage of import
mappings — every existing test stopped at mx check."* That is exactly the gap
this project kept falling into — check, exec and `mx check` all green, data
absent at runtime.

**Flat repro (#23) now works:**

```
 id                | base | ratedate
-------------------+------+------------
 21673573206720654 | EUR  | 2026-08-18
```

**And the whole rates pipeline works** — REST CALL → JSLT transform → import
mapping — which is what FINDINGS #23 recorded as blocked:

```
 rates
-------
    29          <- 29 currencies, one row each: a REPEATING element

 code |    value          base | ratedate   |  amount
------+-----------        -----+------------+---------
 AUD  |  1.64010000       EUR  | 2026-08-19 | 1.00000000
 BRL  |  6.03940000
 CHF  |  0.94020000
```

Two constraints of the inline REST mapping fall away on this route:

- **repeating elements work** (#19) — 29 child rows, not one empty one
- **natural types survive** (#9) — `Value` and `Amount` are Decimal, no CE6099
  and no String coercion

So the recommended shape for a collection is now: inline `REST CALL` for the raw
body, a JSLT transformer if the JSON needs reshaping, then an import mapping
document. The inline REST response mapping remains single-object only.

## 39. PR #188's multi-segment path — now verified at runtime

Previously unverifiable (#35), because #23 blocked every import mapping. With
#192 it runs, and it does what it claims:

```
 itemid |       title       | priority
--------+-------------------+----------
 12     | Replace pump seal | High
```

from `Title = fields/Title` and `Priority = fields/Priority_x0020_Level` — one
entity, no child entity for the `fields` level, and SharePoint's `_x0020_`
encoding handled. In RestLab this would collapse `SPTask` + `SPTaskFields` into
one entity.

## 40. #36 and #37 are unchanged by #192 — both review comments stand

Re-tested on `nightly-122-g2a9c69f`:

- **#36** — an inline REST response mapping still accepts `"fields/Title"` as a
  quoted identifier and stores `(Object)|fields/Title`. `mx check` 0 errors, and
  at runtime only the top-level `id` populates:
  `spitemid 12 | title (empty) | status (empty) | prioritylevel (empty)`.
  Now more pointed than before: the same spelling demonstrably works in a mapping
  document (#39) and silently does not here.
- **#37** — a nested `body: mapping` still passes check ("Check passed!"), still
  executes ("Created rest client"), and still leaves a project mxbuild cannot
  load: `Export Object Mappings cannot have ObjectHandling set to 'Create'`.

## 41. Note for this project: the fix is not in our binary yet

`./mxcli` here is built from merged `main` (`6833c37`) and does **not** contain
the #192 fix. `.claude/bootstrap-mxcli.sh` builds from `ako/mxcli` main, so the
fix arrives automatically once #192 merges.

Until then the rates lane stays as it is — transform and display, with the
`import from mapping` call commented out — because enabling it would break the
app for anyone running the committed toolchain. Once #192 is on main, that lane
can be completed, and `SPTask`/`SPTaskFields` can be collapsed using #39.

---

# Binary download and upload over REST

Added as `mdlsource/13-binary-lane.mdl`, against `httpbingo.org` (`/image/png`
returns a real 8090-byte PNG; `/post` echoes what it received, which is how the
upload is judged rather than "the call did not throw").

**Download works. Upload does not, and cannot.**

## 42. A downloaded file document cannot be CHANGEd — pass it to a typed parameter

Three forms, three outcomes, all measured:

| Form | Result |
| --- | --- |
| `response: file as $Doc` (REST client document) | variable is type **Nothing** — `[CE0041] "Variable 'D' is of type Nothing, but should be of type Object or List."` Unusable as an object. The form names no target entity, unlike `response: mapping <Entity>` |
| the same, plus a `CHANGE` on it | **`.mpr` will not load**: `Change in  has an invalid value '' for property Attribute. The text 'SourceUrl' is not a valid AttributeIdentifier.` — the activity is written with no entity |
| `rest call … returns Mod.FileDoc` (inline) | ✅ works — this form names the entity. **Only on PR #922/#188/#192**; merged main rejects it as a parse error |

A `CHANGE` on the inline result also corrupts the model, so the download result
is write-only in place: `COMMIT` it, and set attributes by handing it to a
microflow whose **parameter** is typed — a parameter carries the entity type the
REST result variable does not:

```sql
$Doc = rest call get '…/image/png' … returns RestLab.DownloadedFile;
CALL MICROFLOW RestLab."SUB_TagDownload" (Doc = $Doc, …);   -- CHANGE lives here
```

Isolated by elimination: `CHANGE` on a **retrieved** `DownloadedFile` — same
entity, same inherited `Name` — loads fine (0 errors). It is specific to the
variable a REST download produces.

**Verified working end to end.** After clicking *Download PNG*:

```
     name      | hascontents | size
---------------+-------------+------
 httpbingo.png | t           | 8090
```

8090 bytes, matching the real PNG, with the blob on disk under
`deployment/data/files/`. Note the inherited members live in
`system$filedocument`; the specialization table holds only its own attributes.

## 43. `body: file from $Doc` sends the TEXT "$Doc", not the file

**Impact: high, and silent.** `mxcli check` passes, `mx check` reports 0 errors,
the request returns **200**, and the payload is wrong.

httpbingo echoes what it received:

```
Content-Length: 4
data: data:application/octet-stream;base64,JERvYw==   ->  b'$Doc'
```

Four bytes — the expression text — while the document held 8090.

**Cause.** `sdk/mpr/writer_rest.go:254` handles `FILE` in the same branch as
`TEMPLATE` and writes a `Rest$StringBody` whose value is the expression:

```go
case "FILE", "TEMPLATE":
    return bson.D{ … {Key: "$Type", Value: "Rest$StringBody"},
                   {Key: "ValueTemplate", Value: serializeValueTemplate(bodyExpr)} }
```

`describe` shows it straight back as `Body: template '$Doc'`.

**And there is no better type to write.** The generated metamodel for 11.13 has
exactly three request-body types:

```
Rest$JsonBody   Rest$StringBody   Rest$ImplicitMappingBody
```

No file body exists. So a consumed REST service **cannot carry a binary request
body at all** — the MDL syntax has nowhere to map. Combined with the inline
`REST CALL` body clause having no file form either (it takes a string template,
an expression, or an export mapping), **binary upload is not expressible in MDL
today**. A Java action is the remaining route.

The fix is not to write a different type but to **refuse `body: file` at check
time**, the way MDL-REST01 refuses a mapping document in an inline mapping.
Silently degrading it to a string body is the worst option: it looks like it
works, right down to the 200.

The lane keeps the broken upload deliberately, as a regression test — when it is
fixed, `Content-Length` becomes 8090 instead of 4. The button says so.

## 44. This lane needs an mxcli newer than merged main

`13-binary-lane.mdl` uses the inline `returns Mod.FileDoc` form (#922), which is
a **parse error** on merged main — the committed `./mxcli` cannot replay it. The
`.mpr` in this repo was built with the PR #192 build and is valid (`mx check`
0 errors), so the app runs for everyone; only re-running that one script needs
the newer binary. `.claude/bootstrap-mxcli.sh` builds from `ako/mxcli` main, so
this resolves itself once #192 merges.

---

# After ako/mxcli #192 merged

`./mxcli` rebuilt from `ako/mxcli` main at `d4998ac` (`nightly-123-gd4998ac`),
which contains #192, #191, #190, #189 and #188.

## 45. The rates lane is now complete — the transform route writes rows

`ACT_Rates_GetLatest` no longer stops at "transform and display". The
`import from mapping` call that FINDINGS #23 recorded as blocked now runs, and a
single click on *Get EUR rates (transformed)* produces:

```
 exchange_rates          base | ratedate   |  amount
----------------         -----+------------+------------
             29          EUR  | 2026-08-19 | 1.00000000

 code |   value
------+------------
 AUD  | 1.64010000
 BRL  | 6.03940000
 CHF  | 0.94020000
```

29 rows from a repeating element, values as **Decimal**. Both inline-mapping
constraints are avoided on this route — `MaxOccurs: 1` (#19) and String-only
attributes (#9) — which makes it the recommended shape for any collection:

> inline `REST CALL` for the raw body → JSLT transformer if the JSON needs
> reshaping → import mapping document

## 46. #44 resolved: the binary lane parses on merged main

`13-binary-lane.mdl` used the inline `returns Mod.FileDoc` form (#922), which was
a parse error on the old main. With `nightly-123-gd4998ac` it checks cleanly, so
the repo no longer carries a toolchain dependency. `bootstrap-mxcli.sh` builds
from `ako/mxcli` main, so a fresh session gets this automatically.

Also visible: #189's honest reporting is now in main —
`Unchanged json structure: RestLab.JSON_Rates` where the old build said
"Modified".

## 47. Correction: SPTask/SPTaskFields CANNOT be collapsed yet

An earlier note suggested #188's multi-segment path would let the SharePoint
lane drop its child entity. **It will not**, because that lane maps through an
inline REST response mapping, where the multi-segment form is still stored
literally (#36) — re-confirmed on merged main:

```
"Title" = "fields/Title",  -- (Object)|fields/Title
```

The path only works in an import mapping **document**. Collapsing the SharePoint
entities would therefore mean converting that lane from the document response
mapping to the `REST CALL` + transformer + import mapping route — a design
change, not a simplification, and it would trade away the lane's demonstration
of nested child-entity mapping. Left as it is, deliberately.

So of the three things #192 was expected to unblock, two landed (the rates lane,
the binary lane's toolchain dependency) and the third does not follow until #36
is fixed.

---

# Testing ako/mxcli PR #193

Built as `nightly-126-g733d6db`. Three commits, all aimed at REST request
handling, and two of them at findings from this project.

| Finding | Under #193 |
| --- | --- |
| #43 `body: file` silently sends the expression text | ✅ **refused** — MDL-REST02 |
| #43's conclusion "binary upload is impossible in MDL" | ❌ **my error — corrected below** |
| #37 nested inline `body: mapping` → unloadable `.mpr` | ❌ still present |
| #36 inline REST multi-segment path | ❌ still present |

## 48. CORRECTION: binary upload IS possible — I checked the wrong metamodel prefix

FINDINGS #43 concluded that "binary upload is not expressible in MDL today"
because the 11.13 metamodel has only `Rest$JsonBody`, `Rest$StringBody` and
`Rest$ImplicitMappingBody`, none binary. **That reasoning was wrong**, and the
#193 commit says exactly why:

> It is a `Microflows$` type, which is why grepping the metamodel for
> `Rest$*Body` finds only the three non-binary ones and appears to prove it
> impossible.

Mendix models a binary request body on the microflow **activity**, not on the
service document:

```
"RequestHandling":     {"$Type": "Microflows$BinaryRequestHandling",
                        "Expression": "$Doc/Contents"},
"RequestHandlingType": "Binary"
```

The conclusion I could defend was the narrower one — *a consumed REST service
document cannot carry a binary body* — and I generalised it to MDL as a whole on
the strength of a grep over one prefix. Worth remembering: an absence proved by
searching one namespace is only an absence in that namespace.

#193 adds the MDL spelling, and **it works end to end**:

```sql
$Echo = rest call post 'https://httpbingo.org/post'
  header 'Content-Type' = 'application/octet-stream'
  body binary $Doc/Contents
  timeout 60
  returns string;
```

One click on *Round trip (download + upload)*:

```
download :  httpbingo.png | hascontents t | size 8090
upload   :  Content-Length: 8090   Content-Type: application/octet-stream
```

8090 bytes both ways — the whole PNG, against the 4 bytes `$Doc` before. The
lane's upload is no longer a known-broken regression test; it passes.

The commit also notes the reverse direction of the same gap: mxcli could parse
that shape but could not write, read or describe it, so **a Studio Pro binary
POST described as a REST call with no body at all**, and re-executing that
describe produced a request that sent nothing.

## 49. #43 itself is fixed — `body: file` is now refused

```
✗ operation "UploadFile": Body: file from $Doc cannot be stored — Mendix has no
  binary request body. (Microflows$BinaryRequestHandling — the shape Studio Pro
  writes). [MDL-REST02]
```

Refused at check time, with the message naming the working alternative. That is
the fix this project asked for, and it now points somewhere useful rather than
at "use a Java action".

## 50. #37 and #36 are unchanged by #193

`733d6db` fixes four defects in the *flat* mapping request body — the export
mapping wrote `ParameterVariable` where the type owns `mappingVariableName`,
`ContentType` was written empty rather than `Json`, and `RequestHandlingType`
was hardcoded `Custom` regardless of handler. Worth having, and none of them is
the nested case.

Re-tested on `nightly-126-g733d6db`:

- **#37** — a nested inline `body: mapping` still passes check, still executes,
  and still leaves a project mxbuild cannot load
  (`Export Object Mappings cannot have ObjectHandling set to 'Create'`). The
  hardcoded `"Create"` for nested children is untouched.
- **#36** — an inline REST response mapping still stores `"fields/Title"` as one
  literal member.

Both PR #188 review comments therefore still stand, and #37's is now sharper:
the *flat* mapping body has just been corrected in the same area of the code,
which makes the nested one a narrow, adjacent fix.

## 51. The lane now needs #193 as well as #922

`13-binary-lane.mdl` uses `body binary`, which is in #193 and not yet in main.
Same arrangement as before: the committed `.mpr` is valid (`mx check` 0 errors)
so the app runs for everyone, and only re-running that one script needs the
newer binary. It resolves itself when #193 merges.

## 52. The bundled skills have no guidance on mocking an HTTP dependency

**Impact: medium** — every REST skill assumes a live third-party endpoint. Sixty-
odd skills ship with `mxcli init`, and none of them mentions Prism, WireMock,
mitmproxy, or any other way to stand up an endpoint you control. Developing a
REST integration against a public API means network, rate limits, credentials
and a payload that can change under you — and none of that is where the Mendix
defects live.

In this project the mocks were load-bearing, not a convenience. `specs/mocklab.json`
exists specifically so that #16 (path parameter corrupts the `.mpr`), #19 (array
root maps to null) and #23 (dynamic property names) reproduce **offline and
deterministically**, in a contract small enough to read. That is a pattern worth
handing to the next project rather than rediscovering.

**Suggested home:** a new `mock-rest-apis.md`, cross-linked from `rest-client.md`
(Approach 0 imports a contract — say where a contract can come from) and from
`test-app.md` (it lists prerequisites for verifying an app, and a REST app's
prerequisite is a reachable endpoint). Both the skills `README.md` and the
`CLAUDE.md` skill table need a row. The three `specs/*.json` here are ready-made
fixtures if the skill wants assets.

**What the skill should carry** — everything below cost time to find out and is
not in Prism's or WireMock's front-page docs:

- **Prism mocks one contract per instance and the client must point at it.** It
  is not an interceptor; asking it to "catch all calls from an existing app" is
  a category error (#30). Install is `npm install -g @stoplight/prism-cli`, ~15 s.
- **Prism mounts paths at the root** and ignores a base path in `servers[0].url`.
  Write `http://127.0.0.1:4020`, not `.../v1.0`, or every path 404s.
- **Make `servers[0].url` absolute.** Then mxcli's OpenAPI import picks up BaseUrl
  automatically; a relative URL forces an explicit `BaseUrl:` (#15).
- **`Prefer: code=404`** forces any documented status — the only practical way to
  exercise a Mendix error handler. `prism mock -d` returns schema-generated
  random data instead of the `example` values, which catches a mapping that
  quietly depends on one fixed payload.
- **Prism enforces the spec's `security`**, so a call with no `Authorization`
  gets a real 401. Useful, and it pairs with the fact that a REST client
  document cannot hold a dynamic header value (#14).
- **Cut a subset; never point Prism at a vendor's full contract.** The official
  Microsoft Graph spec is 41 MB of YAML — it downloads in ~1.6 s and Prism was
  still at "Starting Prism…" when killed at a 300 s cap. Importing it would also
  generate thousands of operations.
- **Runtime→mock traffic works in a proxied container** because `127.0.0.1` is in
  the runtime's `http.nonProxyHosts`. Verified: a microflow call returned the
  contract example in ~267 ms.
- **For an app whose model you cannot edit, use a forward proxy, not Prism.**
  WireMock standalone with `--enable-browser-proxying --trust-all-proxy-targets`,
  pointed at by `JAVA_TOOL_OPTIONS=-Dhttp.proxyHost=… -Dhttp.proxyPort=…`; mxcli
  **appends** to that variable (`localboot.go:226`), so the runtime picks it up
  with no model change. Verified against `api.frankfurter.dev`. The catch is
  `https://`: the proxy needs a CA the JVM trusts, and WireMock 3.13.2 on Java 21
  cannot generate one — use mitmproxy or supply a keystore.

## 53. `rest call … returns mapping … as Entity` still has #192's defect

**Impact: high** — it builds clean and throws at runtime, and it is the obvious
way to write the thing.

`ako/mxcli-formula1` §59 reported an import mapping that "cannot be written from
MDL": a flat, object-rooted, three-string-field token response answered with

```
com.mendix.modules.microflowengine.MicroflowException: key not found: Path(QName(None,),None,)
	at Formula1Backend.Sync_EnsureToken (CallRest : 'Call REST (POST)')
```

That is the same exception this project recorded as #23 and saw fixed by #192.
Its MDL is not the problem — it is idiomatic, and close to what works here.
**The mapping document is fine; the activity is not, and the two ways of
invoking it that were tried happen to share the same broken shape.**

### Reproduced here, on `d4998ac` (which contains #192)

The formula1 shapes, rebuilt verbatim in a scratch module and run through
`mxcli test --local`. `mx check` reports 0 errors throughout, except E:

| | Form | Result |
| --- | --- | --- |
| A | `import from mapping IMM($Json)` — bare | **PASS** |
| B | `import from mapping IMM($Json) first` | **FAIL** — `Path(QName(None,),None,)` |
| C | `rest call … returns mapping IMM as Entity` | **FAIL** — same exception |
| D | `rest call … returns string` then bare `import from mapping` | **PASS** |
| E | `rest call … returns mapping IMM as list of Entity` | **CE0243** at build |

The C failure, logged from a real boot, is identical to the formula1 report down
to the frame:

```
	at MapProbe.ACT_C_RestMapping (CallRest : 'Call REST (GET)')
Caused by: java.util.NoSuchElementException: key not found: Path(QName(None,),None,)
	at com.mendix.integration.importer.mapping.MappingCache.storeValueMappingElement(MappingCache.scala:73)
```

### Why B and C fail together, and why that misleads

#192's fix note is explicit: Studio Pro writes **both** `ForceSingleOccurrence`
and `ConstantRange.SingleObject` **false** for a plain single-object import and
expresses "one object" through `VariableType=ObjectType` alone. Both flags true
is Studio Pro's *First* — "take one of a list" — which on an object-rooted
mapping is what throws. The fix changed only the bare `import from mapping`
form; `first` keeps First semantics **by design**.

The REST-call path was not touched and still mirrors the old inference —
`cmd_microflows_builder_calls.go:1246`:

```go
singleObject := !s.Result.IsList
fso := singleObject                 // both true for `as Entity`
```

So `returns mapping … as Entity` writes exactly the shape #192 identified as
wrong. B and C fail for one reason, not two.

This is why formula1's isolation read the wrong way. Their confirming probe was
`import from mapping IMM($Raw) FIRST`, and `first` is the one spelling the fix
deliberately left alone — so "two ways of invoking it, one failure" reproduced
the same defect twice rather than clearing the mapping. Dropping the `FIRST`
keyword would have passed. Worth remembering when isolating: two routes are
independent evidence only if they do not share the code you are trying to rule
out.

### E is not a workaround

`as list of Entity` sets both flags false — the shape that works — but `mx check`
then rejects the activity, because the mapping's root is an object:

```
[error] [CE0243] "The mapping used to return a value of type 'List of MapProbe.Stg_Token',
        but now returns a value of type 'MapProbe.Stg_Token'…" at Call REST service activity
```

Which leaves, today, **no working `returns mapping` form for an object-rooted
mapping**: single throws at runtime, list fails the build.

### What to do instead

D — the shape this project already recommends for collections, and equally the
answer for a single object:

```sql
$Raw = rest call post '…' … returns string;
$Tok = import from mapping M.IMM_Token($Raw);     -- no range keyword
```

For formula1 that is a three-line change and it removes the reason for routing a
bearer token through DuckDB. The `from_json` workaround is sound and costs
nothing extra in exposure, as their note argues — but it is a workaround, not the
only option.

### For mxcli

Filed as [ako/mxcli#242](https://github.com/ako/mxcli/issues/242). One fix, the
sibling of #192: the REST-call builder should write both pointers
false for a non-list mapping result, exactly as `addImportFromMappingAction` now
does. The fix's own lesson applies again — there was no runtime coverage of
import mappings, and the REST-call route still has none, which is why a fix that
named the right cause left the sibling path broken.
