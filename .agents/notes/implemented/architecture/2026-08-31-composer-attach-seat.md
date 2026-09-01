# Agent Note: The composer attach seat and the external paperclip plugin

Status: implemented

English | [中文](2026-08-31-composer-attach-seat.zh.md)

## Problem

The composer accepted images through exactly two gestures — paste on the textarea and document-level drag-and-drop. There was no click-to-browse path: no `<input type="file">` anywhere in the client, and the tool row's `+` button is the slash-command menu. Two shipped doc comments (`ModelsSection.tsx` "Same glyph as the composer's attach button"; the `conversation.input.left` slot doc's "access mode, plan, attach" resident chrome) already promised a button that did not exist.

Building the button inside `ui-attachment` was blocked by seat/capability separation: the natural home for a small always-visible control is a tool-row seat, but the tool-row owner share (`InputZone`) carries only `{ session, input }` — no image intake. The intake (`addImages`) lives in `ComposerBarInjected`, package-internal to ui-conversation, and cross-package symbol imports are forbidden. The one slot that does carry intake, `conversation.input.attachments`, is `single`-occupancy and already held, so taking it means shadowing at another priority and re-rendering the rail, drop overlay, and lightbox — a 20-line feature inheriting three components.

## Decision

ui-conversation declares a new named seat, `conversation.input.attach` (`single`, `session` scope), beside plan and model in the tool row, with owner share `ComposerAttachOwnerProps`: `locked`, `canAddImages`, `onAddImages`, and `acceptedMediaTypes`. The render site passes `intakeImages` itself — the same callback backing paste and drop — plus `canAcceptDrop` as `canAddImages` (they are the same "may an image enter the draft now" fact) and `imageLimits.mediaTypes` for the picker's `accept` filter. A picking entry therefore gets validation and rejection notices for free and can never diverge from the other gestures.

The button itself ships as an external plugin, `~/Programs/dsh-plugins/dsh-local-image-upload` (`@dsh-external/dsh-local-image-upload`), following the read-aloud precedent: a browser-only bundle whose client half registers `AttachButton` into the seat, a hidden multi-select file input filtered by `acceptedMediaTypes`, with `value` reset after each pick so re-picking the same file still fires `change`. The repo diff is the slot seam only; the consumer is private. The two doc comments that promised "attach" now describe a real seat.

## Alternatives considered

- **Shadow `conversation.input.attachments` from a plugin.** Rejected: shadowing replaces, so the plugin inherits re-rendering the rail, overlay, and lightbox; flagged `shadows-shipped-ui`.
- **Put the button in the tool row with a widened `InputZone` owner.** Rejected: intake is not a tool-row-wide fact, and widening a list-slot owner share to reach one entry's callback invites every entry to grab it.
- **Ship the button in-repo as `ui-attach-local`.** Deferred by the owner: the seam is public and stable, the external consumer is the current need, and an in-repo package can be added later without touching the seam again.

## Consequences

- The seat is a public composition surface whose only consumer is private. That tension is accepted deliberately (owner's call); an in-repo consumer can occupy the seat later by ordinary registration.
- `conversation.input.attach` is `session` scope like plan/model, so with no session the seat does not render — correct, since intake is undefined then anyway.
- The slot-catalog generator output gains the seat row, so `cordis_inspect what:"client"` now advertises it to any model probing the surface.
- The external plugin's type shim re-declares the owner props; a drift between the shim and the real contract is caught only by its own typecheck, not the repo's. The seam types (owner props interface) are the stable contract to watch.
