# Browser AutoNote receiving controls

Extend the existing browser setup panel, using ink #183945, evergreen #28685c, paper #ffffff, mist #edf3f6 and line #aabec5, Avenir body text and existing heading scale. Left-aligned source notes form the primary content; avoid a second dashboard or transport-heavy tables.

Layout: saved offer progress → inspect next encrypted item → explicit receive review → reveal complete notes → meeting, audience, summary and full note groups. Ciphertext export and local deletion have their own confirmation. The review stage uses the existing checkbox/action pattern and wraps long text on phones.

Distinction specific to this workflow: receiving stores encrypted notes; revealing displays a complete source-owned result; neither approves or saves it. Incomplete offers show retained part count and cannot expose partial source notes. The initial panel states that approve/reject return is still unfinished. Raw note text enters the DOM through textContent only, and is cleared on hiding, focus loss, Escape, cancellation, identity change and expiry.

Review against the brief: preserve the existing application style, concentrate attention on actual meeting notes rather than IDs, and do not imply that transport progress is approval. Mount under the existing private-delivery availability flag; no live enablement change accompanies the package.
