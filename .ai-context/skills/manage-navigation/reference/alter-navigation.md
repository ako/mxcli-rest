# ALTER NAVIGATION / ALTER MENU — reference

Item-level edits to a web navigation profile (`alter navigation <Profile>`) or a
menu document (`alter menu Module.Menu`). The operations apply in order to the
stored document and it is written once; a refusal anywhere writes nothing.

## Operations

```sql
mdl 1;
alter navigation Responsive {
  insert before 'Help' { menu item 'FAQ' ( OnClick: open link 'https://example.com/faq' ) }
  insert after 'Home'  { menu item 'Orders' ( OnClick: show page Shop.Order_Overview ) }
  insert into 'Admin'  { menu item 'Audit log' ( OnClick: show page Shop.AuditLog ) }
  insert { menu item 'Last' ( OnClick: sign out ) }        -- append to the top level
  replace 'Help' with {
    menu 'Help' { menu item 'Docs' ( OnClick: open link 'https://example.com/docs' ) }
  }
  move 'Log out' after 'Help';          -- before | after | into
  drop 'Old import', 'Admin' > 'Legacy';
  set ( Caption: 'User accounts', OnClick: show page Admin.Users, Icon: glyph 57377 ) on 'Admin' > 'Users';
  set ( Icon: none ) on 'Home';
  set ( OnClick: nothing ) on 'Admin';  -- the only action a sub-menu may have

  -- page clauses (alter navigation only)
  set home page Shop.Home_Web;                 set home microflow Shop.ACT_Home;
  set home page Shop.AdminHome for Administrator;
  drop home page for Administrator;
  set login page Shop.Login;                   drop login page;
  set not found page Shop.NotFound;            drop not found page;
};
```

- A fragment `{ … }` is written exactly as the `{ }` block of `create navigation`
  (and `create menu`), so a line `describe` printed pastes in.
- `set ( … )` changes only the keys written. `Caption:` writes the project's
  default language and keeps the other translations (as `alter page` does).
- `move` carries the stored item itself — sub-items, every translation, an
  action MDL cannot spell (a page title override). It is not drop + insert.
- `replace` gives the new items fresh `$ID`s, but carries the other-language
  translations of a caption it keeps.

## Addressing

An item has no name, so it is addressed by the caption `describe` prints (the
project's default language), as a path written outer → inner:

| Address | Means |
|---|---|
| `'Users'` | the item captioned Users, anywhere |
| `'Admin' > 'Users'` | Users **directly** under Admin |
| `'Users'@2` | the 2nd Users in describe order |
| `'Admin'@2 > 'Users'` | Users under the 2nd Admin |
| `''@2` | the 2nd icon-only (empty caption) item |

- The first segment matches at any depth; each `>` is one direct step.
- `@n` belongs to its own segment.
- Exact, case-sensitive comparison.
- No positional addresses (`item@3`, `1.2`) — they do not exist.
- `list navigation menu [Profile]` prints every item's shortest Address.

A miss lists the captions at the level searched (and case-only matches); an
ambiguity lists the address of every candidate:

```
alter navigation Responsive: drop 'Users': menu item 'Users' is ambiguous: it matches 2 items — write one of these:
  'Admin' > 'Users'
  'Reports' > 'Users'
```

Copy one of the listed addresses. Do not guess an `@n`.

## Refusals

| Refused | Why / what to write |
|---|---|
| missing or ambiguous address, `@n` beyond the matches | write a listed address |
| `insert into` / `move … into` an item with an action | CE0548 — `set ( OnClick: nothing ) on <item>` first |
| `OnClick:` other than `nothing` on an item with sub-items | CE0548 |
| `move` into its own sub-items, or relative to itself | |
| bare `drop home page` | CE0527 — a web profile needs one; `set home page` changes it |
| `drop home page for R` when R has none | the error lists the roles that have one |
| a native profile | its bottom bar is not written by mxcli; home pages via `create or modify navigation <P> home …` |
| a profile the project lacks | `create or modify navigation <P> home page …` adds it |
| an OnClick a menu item cannot carry (save, delete, close page, complete task) | same as `create navigation` |

## Validation

Only what the statement states is validated: fragment items and `set` values go
through the `create navigation` checks (references CE1571/CE1613, icons
MDL077/MDL078, user roles). A stored item the statement does not name is not
re-judged — so a menu with a bad glyph on some other item can still be edited.

`mxcli check script.mdl -p app.mpr --references` resolves every address with
the code `exec` runs, against the stored menu (successive alters of the same
document see each other's changes), and reports the same refusals.

## Depth

The menu bar renders two levels: a navigation menu three levels deep builds a
CE0549 error ("The selected menu has 3 levels and only 2 are allowed") in a
layout that uses a menu bar. `alter` does not refuse it — the limit belongs to
the widget, not the document — so keep sub-menus one level deep unless the
layout uses a navigation tree.
