# Public companion setup page

`npm run build:site` produces `dist/site`, a static public setup page. The root Vercel configuration publishes only that directory. It does not mount the remote Express application, configure a database, enable connector routes or provision sign-in. The separate remote application remains under its existing explicit deployment and retention requirements.

The page links the available Mac development setup and provenance instructions, public source and public issue tracker. It labels release limitations and does not offer a notarized installer or claim that an app is connected. No JavaScript, forms, analytics, third-party fonts or task input are included. Response headers deny scripts, connections, forms and embedding, and suppress referral information. Domain assignment and successful production publication must be verified separately from build success.

Before this change, read-only checks on25 September2026 returned404 for both ai.bittrees.org and its settings.json route. No live service was changed to prepare this page. Keep dynamic remote APIs out of this static site's hosting configuration.
