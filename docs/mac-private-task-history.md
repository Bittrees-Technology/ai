# Mac accepted-task history for response recovery

The authenticated local `/v1/private-tasks` status now includes `acceptedTasks`: operation ID, local task ID, browser ID and key epoch, and local acceptance time. It reads the existing owner-local encrypted receipt journal with its existing 1,024-row bound. Receipt decryption/schema errors fail the entire read rather than returning partial history. No prompt, result, model selection, source reference, key or credential is projected.

This metadata remains readable after app restart and while new private task dispatch is disabled. It performs no remote identity lookup or native secret read. Local status authentication and owner/tenant isolation still apply. A retained acceptance is historical evidence, not current permission or task completion.

The recovered operation/browser identifiers can be used to review response preparation. Preparation and sending still obtain their separate current native identity, peer/task consent and relay scopes; reading this list does not create or send a response. This closes the identifier recovery gap after a lost task-check reply. Visible Mac response controls are still a separate pending step.

Three tests cover actual retained cryptographic admission and restart, disabled dispatch and no-network reads, response preparation from recovered identifiers, owner/tenant isolation and corrupt rows, plus denial/success through the authenticated local HTTP route. No installed app, personal Keychain, live endpoint, model or Acer news processing is changed.
