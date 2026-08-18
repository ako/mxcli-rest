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
