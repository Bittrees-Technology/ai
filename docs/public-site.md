# Public companion setup page

`npm run build:site` produces `dist/site`. Its root is the static public setup page; the existing `/workflows` entry has its own sign-in and permission controls and retains `noindex`. The root Vercel configuration publishes that directory alongside the existing project-administration API routes. It does not mount the remote Express application, configure a database or enable local connectors. The separate remote application remains under its existing explicit deployment and retention requirements.

The landing page links the pinned public GitHub Mac prerelease, Mac development setup and provenance instructions, public source and public issue tracker. It labels release limitations and does not offer a notarized installer or claim that an app is connected. No JavaScript, forms, analytics, third-party fonts or task input are included in the landing page. The existing response headers restrict resources, deny forms and embedding, and suppress referral information. Domain assignment and successful production publication must be verified separately from build success.

## Public discovery and help

The landing page's canonical is `https://ai.bittrees.org/`. The public sitemap contains only that URL. `robots.txt` permits crawling so the existing `/workflows` noindex directive remains observable, and excludes API and administration paths. These crawler rules do not grant access or replace authentication. The root and Ecosystem footer links connect this preview to Bittrees without changing Agent's separate launch policy.

Setup and support copy is based on the existing [Mac companion guide](macos-companion.md), [download provenance guide](mac-download-provenance.md), [model profile settings](model-profile-settings.md) and [release notice documentation](release-notifications.md). Public help describes user controls and preview limits; it does not publish local paths, connection settings, credentials or runtime records. Updating this website does not update the Mac app or alter its permissions.

Historical baseline: read-only checks on 25 September 2026 returned 404 for both `ai.bittrees.org` and its `settings.json` route, before the setup page was introduced. Keep dynamic remote APIs out of this static site's hosting configuration.
