# Public source export

Run `node scripts/public-source-export.cjs --inventory` to inspect the exact allowlisted inventory. To create a new local source tree, use `node scripts/public-source-export.cjs --output ABSOLUTE_NEW_DIRECTORY`. The output parent must exist outside the source and all Obsidian vaults. Existing outputs are never merged or overwritten.

The helper reads only compiled-in filenames. It does not enumerate the workspace, run builds/tests, access accounts, invoke Git, or publish anything. It exports source, synthetic test code, documentation, build metadata and the two workflows, plus `PUBLIC_SOURCE_MANIFEST.json` containing relative paths, full SHA-256 hashes and an aggregate source fingerprint. It excludes built distributions, local preparation, work areas, runtime settings, auth stores, notes, archives and dependencies. New files require an explicit allowlist review.

The historical `test-fixtures/authentic-beta7-main.js` is executable plugin source used by isolated compatibility tests, not a backup of notes or settings. Its exact SHA-256 is `cd377c8db0c9df6965d648d5b439fd52f88f37d5d5be9c627d81e07c43b65db4`. The helper and test loader reject a changed fixture. Do not install this old client as a migration rollback.

The two `test-fixtures/public-v0.3.0-bridge` files are byte-identical to the existing repository's public [v0.3.0 bridge source](https://github.com/AdekWhat261/amygdala/tree/v0.3.0/bridge), checked on 2026-10-06. Both hashes are pinned in the helper. The fixture supplies fake-provider tests; it does not deploy a bridge or demonstrate current Google authentication.

Static checks reject recognizable credentials, private home paths, external source traversal and concrete Google resource links. Findings contain file/line/category only. This scan is bounded evidence, not a guarantee that arbitrary source has no private information. Review any allowlist changes before public upload. The production OAuth bridge URL is public configuration, not a credential. Tests use explicitly synthetic credentials and note strings.

An export is not a release, publication, installation, successful hosted CI run, or real-device acceptance. Run the established build/tests on the exported tree and record its fingerprint separately before an authorized repository update. Release assets remain the minimal plugin files, independently packaged by `scripts/release-package.cjs`.
