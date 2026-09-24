# Mac private relay controls

This extends the existing Connections view. It is a local control surface for one Mac's separately granted relay connection, not an AI model picker or a status-pairing shortcut.

Use the established palette: ink #183945, canvas #edf3f6, paper #ffffff, outline #aabec5, focus #29658b. Keep Avenir/Avenir Next at the existing 15px base; ordinary sentence-case headings carry the hierarchy. Left-align explanatory copy and place record-specific actions beside their state on wide screens, wrapping vertically on narrow screens.

```
Private message connection                 Refresh saved connections
Plain explanation of saved access and current delivery availability
[review an approval, when this build explicitly allows setup]
Saved connection state                     [check] [stop] [revoke] [remove]
    Connection details (expandable)
Review chosen change                       [acknowledgement] [confirm] [cancel]
```

An initial proposal used one colored status card per permission. The final layout instead uses the existing connection panel and ordinary record sections: color should not imply that local deletion proves remote revocation. The important distinction is textual: saved locally, stopped locally, needs repair, or remote revocation confirmed. Explanations for uncertain setup and deletion offer a concrete next action. No hero, decorative metric, animation or new navigation is needed for this settings extension.

Reviews are inline, keyboard accessible, and cleared by focus loss, Escape, expiry or navigation. Confirmation is never retried automatically. Visible actions refer to this Mac, the remote permission, or requested cleanup explicitly. Browser/native acceptance and screenshots run only in disposable GitHub CI; no local GUI automation.
