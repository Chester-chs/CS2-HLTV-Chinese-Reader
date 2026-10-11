# Dictionary state and review contract (local v1.0.4)

The owner approved due/unreviewed-only review on 2026-10-11. This is the local implementation contract, not evidence of a published release or live browser validation.

- Existing storage keys remain dictionaryHistory, dictionaryFavorites and dictionaryReviewState. Background messages serialize reads and writes through the one existing queue.
- set-favorite accepts a validated DictionaryEntry and boolean favorite. It sets the requested state idempotently; it does not invert a potentially stale stored state. The older toggle-favorite operation remains compatible, while production card/history controls use set-favorite.
- Content storage notifications refresh the open card's star. Initial/external reads use revisions; saving locks the star and a post-save read reconciles any concurrent external change. Read/write failures remain visible.
- list-review returns normalized finite dueAt/interval records through the same queue. Unreviewed favorites and records with dueAt <= the session-start time form a fixed queue; unreviewed first, then oldest due time. Both existing rating controls write through record-review.
- Remembered uses 1 day initially, doubles the previous interval up to 30 days; Review later schedules 1 day. A no-due notice is explicit render state, retained across ordinary history updates; filter navigation, retrying review, or changed favorites/review records returns to current state. No daily alarm or scheduler permission is added.
- Scroll (including nested scroll containers) and window resize dismiss the fixed magnifier and clear a pending display timer; a fresh text selection shows it again.

The closeout pass adds regression tests for review intervals, backup state, cancellation and cache races, alongside source review/type checking/build checks. Live device speech, real providers and rendered browser interactions still require owner testing. Backup and cancellation contracts are in `closeout.md`.
