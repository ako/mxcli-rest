---
name: choose-edit-mode
description: "Decide how to change a document that already exists: ALTER, describe → edit → CREATE OR MODIFY, or a new document. The answer depends on who owns the document (your MDL scripts or Studio Pro). Use before editing anything in an existing app, before re-executing DESCRIBE output, and before touching a Studio Pro-authored microflow or nanoflow."
---

# Choose the Edit Mode by Who Owns the Document

MDL has two ways to change a document, and each is safe in a different situation.

| | Declarative | Patch |
|---|---|---|
| Statement | `create or modify <type> X ( … ) { … }`, the whole definition | `alter <type> X …`, only the change |
| Source of truth | your `.mdl` scripts | the stored model |
| Use for | new apps and modules; documents your scripts created and nobody has edited since | documents made or edited in Studio Pro; marketplace modules |
| Risk | drops whatever the statement does not say, including content MDL cannot express | none for what it does not mention |

## The rule

1. **New app, new module, new document: write declarative MDL.** There is nothing to
   read and nothing to preserve.
2. **Existing Studio Pro document: change it with `alter`.** An `alter` leaves every
   element it does not name untouched. Measured: `alter page … set Caption` changed
   one string and byte-preserved every other translation on the page.
3. **describe → edit → `create or modify` only for documents mxcli created** and whose
   stored state is still what your script produced (nobody has changed them in Studio
   Pro since). On a Studio Pro-authored document this path is lossy even when you
   change nothing. On real projects it has flipped association storage from table to
   column, dropped page translations, dropped nanoflow annotation links, changed export
   levels, and dropped a snippet's type. `mxcli diff` shows none of these.
4. **Never `drop` and re-create an existing document to change it.** The new document
   gets new identities. For an entity, the runtime then drops its table and its rows.

Not sure who owns it? Treat it as Studio Pro-owned.

## Which document types have `alter`

`./bin/mxcli syntax` is authoritative. At the time of writing:

| Document | Patch statement |
|---|---|
| Entity, attribute, index | `alter entity` (add / rename / modify / drop attribute, set …) |
| Association | `alter association … set …` |
| Enumeration | `alter enumeration` (add / rename / modify / drop value) |
| Page, snippet, layout | `alter page` / `alter snippet` / `alter layout` { set / insert / drop / replace } |
| Workflow | `alter workflow` { set / insert before / after / into / drop / replace } — activities by name or 'caption' |
| Settings, security | `alter settings`, `alter app security`, `grant` / `revoke` |
| Many pages at once | `update widgets … where …` (see `bulk-widget-updates`) |
| **Microflow, nanoflow** | **none yet** |
| Menu, navigation profile, Java action | none (`alter navigation` replaces the whole profile) |

## Types with no `alter`: microflows, nanoflows, menus, Java actions

The only way to change one is to re-emit the whole document with `create or modify`.
On a Studio Pro-authored microflow that rebuild renumbers element IDs, removes merges
and resets connector curves, even for a one-line change. So:

- **Prefer adding over editing.** Put new logic in a new sub-microflow that you create
  declaratively, and limit the change to the existing flow to the one call that
  reaches it.
- **Keep the change minimal.** Start from fresh `describe` output, change only the
  lines you must, and do not reformat, reorder or tidy anything else.
- **Review the result before you hand it over.** Commit (or copy the `.mpr`) first.
  After `exec`, `describe` the document again and diff it against the original output.
  On an MPR v2 project, also check that `git status mprcontents/` lists only the units
  you meant to change (`mxcli diff-local` shows them as MDL). Anything else that
  changed is a loss, not your edit.
- If the flow is large or the change is broad, tell the user and suggest making the
  change in Studio Pro.
