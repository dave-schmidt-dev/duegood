# Due Good desktop cutover runbook — 2026-09-23

**Status: the signed Phase 5 desktop candidate is installed and its synthetic native gates passed; the owner-attended cutover steps below are pending.** A private preparatory copy and Rust dry run passed, but it is not the frozen rehearsal backup. This is the planned Phase 5 cutover. It records no private paths, account identifiers, token values, coursework, or run results. Replace angle-bracket placeholders locally; do not paste their resolved values into Git, tickets, or shared evidence. Stop on any failed check or unexpected writer.

## Before rehearsal

1. **Content-free source dry run.** Run the legacy-root dry run against `<PRIVATE_LEGACY_ROOT>`. Record only totals, refusal counts, lock state, and result. Refusals for entries outside the Due Good layout are expected; confirm those entries remain in place. Do not copy their names or contents into evidence. Stop if the Due Good layout itself is refused, the legacy writer is active, or the result is unclear.
2. **New Canvas credential.** With the owner present, create a new Canvas token for the app's read-only refresh and store it directly in BWS as `<TOKEN_SECRET_NAME>`. The client remains GET-only. Do not paste the token into chat, a shell command, a file, or the application. Keep the old credential available only for the rollback/soak window.
3. **Pin the desktop consumer.** Add or update the fixed `duegood-desktop-refresh` consumer in BWS to authorize the installed helper at `<HELPER_PATH>` with the exact SHA-256 digest printed by the installer (`<SHA256_FROM_INSTALLER>`). Verify the path and digest from the installer output. Never invoke the helper outside `bws-secret-exec` or print the secret to test the mapping. After any reinstall, repeat this owner-attended pin using the new installed helper digest before refresh.
4. **Private recovery copy.** Copy the legacy Due Good layout to a new private backup at `<PRIVATE_BACKUP_DIR>`. Restrict access to the owner. Record the backup location only in the owner's private notes and retain a content-free file-count/byte-count and digest manifest. Do not move or include adjacent notes, assignments, or unrelated project files.
5. **Record service state.** Record whether `<SERVICE_LABEL>` is loaded and the private plist path `<PRIVATE_PLIST_PATH>`. Keep the plist. Resolve the current GUI domain as `gui/<UID>` locally; do not put the UID or private paths in shared evidence.

## Rehearsal

1. **Stop the legacy writer.** With the owner present, boot out the service while retaining its plist:

   ```sh
   launchctl bootout "gui/<UID>" "<PRIVATE_PLIST_PATH>"
   ```

   Confirm it is no longer loaded. If it remains active, stop here; do not import or refresh while two writers may run.

2. **Prepare an import root.** Run `npm run legacy:prepare-root -- --source <PRIVATE_LEGACY_ROOT> --destination <PRIVATE_PREPARED_ROOT>` with a new destination under a private parent. The script must preserve the original, copy only the Due Good layout, enforce private permissions, and report source before/after digests plus content-free counts. Do not proceed if validation fails, the source changed, or the operation would affect entries outside the Due Good layout.
3. **Check and import.** Run the content-free dry run on `<PRIVATE_PREPARED_ROOT>`; require zero refusals. Import it as a preview copy. If replacing a preview, use the app's archive-before-replace action. Keep the frozen backup unchanged.
4. **Prove equality before refresh.** Export the imported preview store to `<PRIVATE_PRE_REFRESH_EXPORT>`. Compare the Due Good layout subset byte-for-byte with the corresponding layout in `<PRIVATE_BACKUP_DIR>`, using the cutover verifier. Require an exact equality result and content-free report. Any mismatch stops the rehearsal; do not promote or refresh.
5. **Promote only with the owner present.** In More, use `Choose and compare backup…` to select the frozen backup through the native picker. Require the app's exact layout match and a fresh readiness proof. Then use `Promote to authoritative store` and answer the native confirmation. The app rechecks the same bytes and locks before changing the manifest state. A cancel, mismatch, changed byte, or expired proof stops the cutover; repeat preparation instead of editing the manifest. Record the resulting state without coursework data. Confirm refresh is available and that no legacy writer is loaded.
6. **Run one live refresh.** Start exactly one desktop Canvas refresh through the installed app and fixed BWS consumer. This is the first step that should use the new token or contact Canvas. Record only start/end time, result, content-free progress, and error category. Require a complete successful refresh and inspect the app with the owner. An incomplete, failed, or ambiguous result stops the rehearsal; preserve the pre-refresh export and recover before continuing.

## Rollback drill

1. In More, use `Return app store to preview…` with the owner present and answer the native confirmation. Require a verified private recovery copy, preview state, and Canvas refresh unavailable.
2. Use `Export frozen rollback copy…` to choose `<PRIVATE_ROLLBACK_EXPORT>` through the native picker. Require the write-frozen source/export equality result before restoring anything. Keep `<PRIVATE_BACKUP_DIR>` unchanged; move the original layout aside to a new private location rather than deleting or overwriting the only copy.
3. Replace only the Due Good layout entries in `<PRIVATE_LEGACY_ROOT>` with the rollback export. Leave unrelated entries untouched. Verify the restored layout against the export with a content-free equality report.
4. Restore the service using its retained plist:

   ```sh
   launchctl bootstrap "gui/<UID>" "<PRIVATE_PLIST_PATH>"
   ```

   Confirm the browser app is serving from the restored legacy tree and behaves as expected. If service restoration or equality fails, stop and use the private backup to recover; do not begin final cutover.

## Final cutover

1. Repeat the content-free dry run and record fresh counts. Make a fresh private frozen backup at `<PRIVATE_FINAL_BACKUP_DIR>`; confirm no unexpected legacy writer is active.
2. Boot out `<SERVICE_LABEL>` again with `launchctl bootout`, retaining its plist. Prepare a new private root at `<PRIVATE_FINAL_PREPARED_ROOT>`, require zero dry-run refusals, and import through the preview archive/replace flow.
3. Export the imported store before refreshing. Require exact byte equality between its Due Good layout and the corresponding layout in `<PRIVATE_FINAL_BACKUP_DIR>`. Stop on mismatch.
4. With the owner present, repeat the native backup comparison, fresh readiness proof, and native confirmation before promoting to authoritative. Disable the retained launchd service without deleting its plist (for example, `launchctl disable gui/<UID>/<SERVICE_LABEL>`), and verify it remains booted out. Disable, but do not delete, the legacy `canvas-course-refresh` BWS consumer mapping. Retire the private wrapper's `--inbox-only` and `--profile-only` entry points and derivative writers, and repoint or disable the private launcher. Do not remove the Node backend during the soak period.
5. Resolve the installed production app with `open -b com.zerodelta.duegood`. Verify the app uses the authoritative store, the latest refresh succeeded, refresh is enabled and available, and the legacy service and consumer are disabled. Confirm the installed app is the only active writer. Record content-free evidence only.

## Access, reinstall, rollback, and soak

- **TCC:** The owner grants access to the selected legacy folder through the native folder picker when macOS asks. Record whether access was granted, not private folder details. A denial or unexpected prompt blocks the step. Any reinstall or changed signing identity may require the owner to grant access again; do not bypass macOS privacy controls.
- **Reinstall or upgrade:** Close the production app first. The installer verifies a same-volume staged bundle, keeps the prior signed app as a separate backup, swaps app directories by rename, and restores the old app on a verified failure. It leaves the app data root alone. Recheck the installed helper's path and digest, owner-attended re-pin `duegood-desktop-refresh` to those exact bytes, verify the consumer is enabled, and confirm store status before refreshing. Never assume a prior path/digest pin still matches.
- **Rollback after final cutover:** Stop desktop writes first. Demote the app store to preview so refresh is unavailable; export the full tree; preserve the frozen backup and move the legacy layout aside; restore only the Due Good layout from the export; re-enable and bootstrap the retained legacy plist; re-enable the legacy consumer mapping only if required for the browser refresh path. Verify content-free equality and browser service health before returning to use. Keep the desktop app and backups intact until the owner accepts recovery.
- **Old credential:** Keep the former Canvas token available only for the agreed soak and rollback window. After the owner accepts the desktop app and the soak period ends, the owner revokes the old token in Canvas. Record the revocation outcome without the token or account data.
- **Evidence:** The implemented verifier requires `--checkpoint post-refresh` or `--checkpoint rollback` with `--rehearsal`, or `--final`, plus private source, export, store, service-label, and owner consumer-attestation arguments. It requires both compared trees to contain the Due Good layout anchors and checks the fixed desktop BWS broker. Run `npm run verify:cutover -- --help` for the exact interface. Record actual exit status, content-free equality, service state, store state, and app resolution only after each attended procedure runs. A passing synthetic test, source review, or dry run is not a live cutover result.
