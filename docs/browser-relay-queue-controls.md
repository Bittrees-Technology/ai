# Reviewed browser reply queue

The browser task panel can inspect one waiting reply, review checking that exact
message, or inspect one message after it. This lets a valid result behind an
unreadable message be reached without discarding or acknowledging the first one.
Each network operation needs a fresh, unchecked review. Inspection displays only
transport identifiers, storage time, revision and deadline; it is not proof of a
Mac's identity, task acceptance or result authenticity.

The existing Avenir typography, pale blue canvas, ink text and green action styling
stay in place. The queue is a left-aligned section beside the task workflow, with
one paragraph of status and direct actions. Long identifiers wrap using the
existing reference style. Result text remains in the separately reviewed output
area. Desktop and 390-pixel previews cover inspection, exact review, looking past,
saved reply and empty position.

Positions are temporary and bound to the signed-in browser session and current
browser binding. Blur, Escape, invalidation, expired binding and unrelated actions
clear them. Refresh preserves the current position so a rejected message can be
looked past. Return to queue start is local only. Each inspection polls once with
limit one; a session can look through at most 20 positions. There is no automatic
scan, persistent cursor, delete action or automatic retry.

Checking a selected reply sends its original cursor plus exact message ID, hash,
revision and storage time. The trusted host compares these before opening or
saving content. It then applies current identity and separately granted result
permissions and saves authenticated content before acknowledging delivery. The
UI also verifies the returned message ID and disables rechecking a successfully
saved selection. A changed reply needs another inspection. Result reading remains
a separate review even after a successful check.

Reviews use the existing two-minute wall and monotonic deadlines; selected checks
are additionally capped by message expiry. Scope and history are checked before
dispatch and after asynchronous work. Hidden or superseded work cannot restore a
selection. This does not retract a server acknowledgement that already completed.

Acceptance runs only on disposable GitHub browser runners against the real
HTTPS/PostgreSQL relay and native task fixture. Cases cover unreadable-first
recovery, exact selection changes, blur during polling, Escape, local reset,
hidden results, and preserving the rejected message. Local static/build checks
do not establish browser acceptance. Installed apps, live relay services, models
and Acer news processing are unchanged.
