# Remote r1 retained-artifact recovery — Windows/Linux only

## Later user-approved distribution decision

After the immutable tag `remote-v4.0.21-r1` was created, the user explicitly
requested: **“macOS的包去掉，后面都不弄了”**. This applies to this release and
future desktop/helper packaging. Only Windows x64 and Linux x86_64/arm64 desktop
packages, and Linux x86_64/arm64 helpers, will be published. Completed macOS
artifacts are not used or uploaded. Historical desktop macOS release assets are
not deleted. Existing remote macOS SSH support/business code is not removed.

This document is separate maintenance evidence; the desktop tag remains at
`c0b701e44bf89fb1d264236949a3af2745af1989`. The released identity asset is copied
unchanged from that source. Version, schema 23, updater key and endpoint stay fixed.
The recovery body is based on original-tag notes, with the superseded macOS
packaging statements removed and this explicit distribution decision appended.

## Fixed provenance; no rebuilding

`recover-r1-artifacts.yml` is manual only, with `operation=desktop|helper|all`.
Tag/source and the two run inputs must equal reviewed defaults. It runs only in
`PowerDi/cc-switch-remote`, on main or `release/remote-v4.0.21-r1`.

- Desktop original run `45752512886`: Windows job `139683524263`, Linux x64
  `139683524221`, Linux arm64 `139683524268`.
- Helper original run `45752621175`: Linux x64 job `139683738343`, arm64
  `139683737970`.
- Both run heads are the immutable source SHA. Overall cancelled status is allowed
  because the exact selected platform jobs succeeded; the skipped publishers and
  exact repository/event/branch/path/attempt are verified separately.
- Only **five** artifact names/IDs/sizes/SHA-256 digests are pinned (three desktop,
  two helper). No repair macOS run, log or artifact is required.
- Downloaded ZIP SHA-256 must match GitHub API and the reviewed pinned digest.
  Extraction allows only exact flat file names; traversal, links, special files,
  duplicate names, encrypted entries and unexpected files fail closed.
- No Cargo, Tauri, frontend build, tests, app execution or system installation runs
  inside this workflow. Previously successful Linux/Windows outputs are reused.

## Durable backup before mutation

`prepare` performs GitHub reads only. Original-tag identity/readiness/publication
validation and the original assembler execute from a separate immutable checkout.
Main ancestry, unchanged source tag, official published v4.0.21/peeled SHA and all
actual non-draft fork releases remain required; the publication gate is not skipped.

Before `apply`, upload the plan/evidence and **every existing rolling helper asset
and metadata**—initially all six old assets including macOS—to a 30-day recovery
artifact. Apply confirms its run/head/artifact ID/digest, downloads it, and checks
every entry against the local plan. Backup failures stop before any mutation.
Download this artifact for longer retention if needed.

## Desktop transaction

1. Validate exactly **11 platform files** (Windows 3, Linux 4 each).
2. Verify the **three** updater artifacts (MSI and two AppImages) with fork public
   key `E490AF071AC1237F`: Ed25519 `ED` BLAKE2b prehash or `Ed` raw payload,
   plus the trusted-comment signature. Key IDs alone are not sufficient.
3. Invoke the **original tag's assembler** with explicit
   `--required-platforms windows-x86_64,linux-x86_64,linux-aarch64` since its old
   default included macOS. Assert the resulting latest.json has exactly those
   three platforms; copy the original identity snapshot. Final desktop count: **13**.
4. Create/resume only the owned matching draft. Read back all uploaded asset
   states/sizes/SHA-256 values. Never overwrite different valid uploads; only failed
   `starter` upload stubs may be removed for a retry.
5. Under `remote-app-publication`, re-run fresh publication preflight after upload,
   then set `draft=false`, `prerelease=false`, `make_latest=true`. New inventory/tag
   drift leaves the draft unpublished. A completed exact match is a no-op; do not
   delete/recreate published releases or move the desktop tag.

## Helper transaction and retiring old macOS rolling assets

- Operate only on existing release ID `411740731`, rolling tag
  `remote-helper-latest`; its starting commit must be the reviewed old
  `ed4353caf8536d8a7b902e799ff5f59c082178d5` or target source.
- Preserve all existing bytes/metadata before mutation. Unknown assets/digests fail.
- Stage **two versioned Linux candidates** first, then replace the **two Linux
  latest aliases**. Each candidate/alias pair must be identical. Old macOS alias
  and old versioned files remain untouched until Linux promotion is confirmed.
- Verify all **four** new Linux assets, promote only the rolling tag, update notes
  (`prerelease=true`, `make_latest=false`), and verify again. Promotion failure
  restores old Linux aliases/tag/notes and verifies original macOS state is intact.
- Only after that commit point, remove the **three reviewed old SHA files plus
  the old macOS latest alias**. Cleanup checks their exact approved IDs and hashes:
  old Linux arm64 `687510727`, x64 `687510726`, macOS SHA `687510750`, macOS alias
  `687510815`. Final channel has exactly four Linux assets. This is the explicitly
  authorized rolling-channel scope change, not historical desktop deletion.
- Cleanup failure retains the valid new Linux channel and remaining old assets;
  rerun can finish without a rebuild. Promotion rollback can itself fail during
  API outages; failure must be reported, with manual recovery from the uploaded
  full backup. Do not overwrite unknown externally changed state.

## Future workflows and historical maintenance

Future desktop/helper matrices and dispatch choices omit macOS entirely; macOS
build/signing/notarization steps are removed. Source-ref pinning remains for
supported Windows/Linux targeted builds. Default updater requirements are the
three supported platforms. Historical release maintenance downloads its existing
latest.json and requires its entire prior platform key set, including any macOS
keys; existing old artifacts/signatures are not silently trimmed by new defaults.

The ordinary helper publisher shares `remote-helper-publication` locking. Desktop
recovery shares the normal desktop lock. These are publication-only operations,
not tests of installed-client upgrades or remote SSH/database/runtime behavior.
No real installation or GitHub mutation was executed while implementing this code.
