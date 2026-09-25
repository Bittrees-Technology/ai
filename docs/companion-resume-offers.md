# Reviewed Mac resume offer API

The authenticated companion now exposes GET `/v1/private-resume/offers`, POST `/v1/private-resume/offers/prepare`, and POST `/v1/private-resume/offers/confirm`. They use the existing literal-loopback host, bearer and origin checks. No new listener or startup activation is added.

Preparation accepts an exact create, reveal or stop action. Creating binds an existing independent resume permission and consent revision; reveal/stop bind an existing offer revision. The response shows task/model/browser identity, fingerprint and expiry, without task text or ciphertext. Preparation writes no offer. Confirmation requires the returned review ID plus separate confirmation and acknowledgement; it consumes the review once, and never retries an uncertain result.

Create and reveal obtain fresh verified device identity, resolve current key/peer/permission state and re-pin the approved local model during review and again at confirmation. Review expiry uses wall and monotonic clocks. The parent’s shared native-operation lock and cross-panel invalidation apply. A late model result after invalidation cannot allocate or reveal an offer. Confirmation prepares/encrypts/returns the retained original envelope, without relay upload, browser consent or task execution. Interrupted encryption remains recoverable through a fresh reveal review of the retained preparation.

Stopping works with remote setup disabled. It stops later offer revelation; it does not revoke the separately saved resume permission or erase exported copies. New create/reveal operations remain disabled unless private resume setup has been explicitly enabled.

All 942 local tests pass, including eight new real authenticated HTTP/controller/cryptography cases for auth/origin, exact review, model/task changes, original-envelope reveal, review invalidation, expiry/acknowledgement, disabled setup, in-flight cancellation and offline stop. Typecheck, builds and unchanged public contracts pass. Current native/browser/migration CI remains required before integration.

Mac offer controls, independent browser consent, shared browser replay admission, relay transport and command/receipt UI remain unfinished. No personal data, Keychain, installed app, model/default, deployment or Acer news change.
