# Local workspace response boundaries

Locking or an authentication failure clears the local dashboard and permanently closes its request scope. Confirmed local-data deletion closes the old scope, clears selected content and remounts the paired controls with a fresh scope. Unmount also closes the scope.

A closed scope rejects requests before dispatch and rejects both successes and errors that arrive after dispatch. This prevents a delayed model-profile creation from issuing its next default-profile request, an old export from starting a download, and an old authentication error from clearing a newly paired workspace. Actions suppress obsolete errors and busy-state completion. Task/memory/profile refreshes apply only the latest initiated snapshot in the current scope. The existing bounded HTTP transport still performs no automatic retries.

This is a view/continuation boundary, not transaction cancellation or server authorization. A submitted write may already have completed before locking. Inspect its current state after pairing again before submitting it again. The server remains responsible for authentication, authorization, revisions and idempotency. An expired or failed session is still rejected by the server. In-flight network requests are not recalled, and this code does not promise JavaScript memory erasure.

Task run history mounts per task/revision/source-bound status and discards previous rows immediately when that identity changes. Loading, unavailable and an empty successful response are distinct states. Current errors allow an explicit history refresh; late success/error after changing task or leaving Tasks is ignored. Connected-app tasks keep their existing history concealment. Model discovery similarly ignores effects after leaving Models.

Verification uses transport tests plus the actual React dashboard in disposable GitHub Chromium, Firefox and WebKit with synthetic routed HTTP. It covers stale history success/denial, unavailable-history refresh, locking during profile creation and export, fresh pairing, deletion/remounted controls and overlapping task refreshes. This does not establish native window/Keychain acceptance or a real-user source pilot. No database schema, models, defaults, remote service or Acer-server configuration is changed.

The existing Avenir/system typography, ink `#183945`, mist `#edf3f6`, white, evergreen `#28685c` and focus blue `#29658b` are retained. History remains left aligned within task detail; status copy and a single refresh button provide recovery without introducing another dashboard layout.
