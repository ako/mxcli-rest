# Cross-document flow rules `check -p` predicts

Two rules between documents that only a project can answer: whether a used flow
has an allowed role, and whether a call crosses "apply entity access". Both run
with `check -p` and simulate the script against what the project stores.

## A used flow left without access — `MDL-SEC21` (CE0106)

With a project (`check -p`), `check` simulates the script's creates, drops,
grants and revokes and reports a microflow or nanoflow the script leaves with
**no allowed role** while something that needs one names it. MxBuild's error:

> CE0106 "At least one allowed role must be selected if the microflow is used
> from navigation, a page, a nanoflow or a published service."

Measured on Mendix 11.14: a page button or data source, a snippet, a navigation
or menu-document item, or a nanoflow call needs a role (even from an unused
snippet, menu document or nanoflow). A **published REST operation does not**,
nor a microflow called only from another microflow, nor an excluded page. It is
an **error at security level Prototype or Production** and a warning at Off,
where MxBuild does not check it.

The usual cause is **drop + create in separate runs**: a create in a later run
is a *new* flow, and a new flow in a module that has its own module roles gets no
access. Within one run, and with `create or modify`, the stored roles are kept.
Fix: `grant execute on microflow M.Flow to M.Role;` in the same script, or rebuild
with `create or modify microflow` instead of dropping. Only what the script
*changes* is reported — a project that already has CE0106 does not fail an
unrelated script; `mxcli docker check` shows those.

## A call across entity access — `MDL-SEC22` (CE0114)

With a project (`check -p`), a microflow that does **not** apply entity access
calling a microflow (or deciding on a rule) that **does** is an error. MxBuild:

> CE0114 "A microflow that does not apply entity access can only call
> microflows that also do not apply entity access." (or "… rules …")

Only that direction fails. Measured on Mendix 11.13 and 11.14: on -> off, on -> on
and off -> off build clean, as do a nanoflow caller (it has no such setting) and an
excluded caller, at every security level. The callee may be in the project or
created earlier in the script; an absent `@applyentityaccess` on `create or modify`
keeps the stored setting. A callee neither holds is not judged. Fix: put
`@applyentityaccess` on the caller, or call a flow that does not apply it — turning
it off on a shared callee widens what it may read and write for every caller.
