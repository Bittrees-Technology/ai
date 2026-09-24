# Task-linked Inbox message review

Inbox paging previously retained earlier message text while polling only after its
last cursor. Even when the HTTP history route rechecked source access, already
loaded task-linked text could remain on screen indefinitely. Task questions and
answers made this an exposed display path.

The paging controller now retains only a placeholder for any task-linked message.
Ordinary local messages keep their existing display. Opening linked text performs
a fresh authenticated single-message read: owner access, current task/source
projection, local dependencies and task/memory change tokens are rechecked before
returning text. Denied source access returns no body content.

The existing Inbox offers explicit open/hide controls. A display lasts at most
15 seconds from the request start, checked against wall and monotonic time, and
clears on blur, visibility changes, Escape or component disposal. Old reads cannot
restore text after that invalidation. Reopening clears old text before checking
access; a denied read cannot leave the previous content visible. This bounds the
review display; it does not claim instant notification of remote revocation or
secure erasure of JavaScript memory.

Four new engine cases cover cursor caching, exact identity, both clocks, expiry,
held reads, focus loss and denied reopens. The real CRM/SQLite/authenticated HTTP
fixture covers authorized reading and denial after source revocation. Three new
browser scenarios across Chromium/Firefox/WebKit use the actual Inbox component
with synthetic HTTP responses and cover fresh/denied reading, held reads across
blur/conversation changes, Escape and narrow-screen expiry. Actual disposable CI
execution and the eighteen saved preview reviews remain required before acceptance.

No task is started or resumed by opening text. The owner-answer API/screen, model
question policy and separately consented encrypted conversation messaging remain
open. This package changes no schema, runtime, installed app, personal keys/data,
live service or Acer news/model processing.
