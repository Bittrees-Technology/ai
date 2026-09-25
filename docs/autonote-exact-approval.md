# Exact AutoNote approval from the Mac

Keep the existing companion palette (canvas #edf3f6, ink #183945, white #ffffff, border #aabec5, focus #29658b), Avenir/system type and left-aligned task review area. Add an exact-save section beside the existing source-review link, rather than a new destination. Show meeting title, audience, expiry and complete resulting notes with an unchecked acknowledgement, explicit save and cancel. Uncertain outcomes point to the existing receipt check.

The design follows the actual AutoNote workflow: source upload first, separately granted approval permission, exact resulting notes and source-owned final write. It must not imply CRM publication. Review clears on focus loss, hidden window, Escape, context change or expiry. Cancellation before dispatch prevents a save; cancellation after dispatch cannot undo it and must lead to receipt reconciliation.

The service holds short-lived one-use review handles only in memory. It compares the fresh source detail before saving, writes an encrypted attempt/uncertain state first, then validates and stores the receipt. Lost responses and restarts never automatically resend. The optional attempt metadata extends the existing encrypted review payload; the database schema is unchanged. Encrypted browser delivery is a subsequent package, not claimed by this local review flow.
