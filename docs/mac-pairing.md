# Connecting the Mac and website

Opening the installed Mac app connects its own window to its child engine automatically. The native launcher creates a fresh, one-use bootstrap secret for that process; it is never placed in a URL or written to the pairing-code file. The engine accepts it only on its protected loopback endpoint. Locking the workspace revokes the native session. Browser pairing remains separate and does not invalidate the native window.

To connect workflow permissions on ai.bittrees.org:

1. In the Mac app, open **Workflows → Permissions & sync**.
2. Select the model and choose **Create pairing code**.
3. Choose **Continue on ai.bittrees.org**. The website receives the short-lived workflow reference and fills it in.
4. Sign in, review the device and exact permissions, and approve only the intended scope.

**Use a code instead** exposes a manual copy option. The menu’s **Copy pairing code** is for a separate local browser workspace; it is not the website workflow code. Website transfer uses a URL fragment, clears it immediately, and retains the pending reference in tab session storage for at most five minutes across shared sign-in. It never approves access automatically.

Remote private-task pairing remains a distinct approval flow. Existing wallet signatures, source permissions and revocation checks still apply. This UI change does not activate until-revoked delegation or source app access.
