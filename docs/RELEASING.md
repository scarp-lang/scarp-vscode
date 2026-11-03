# Pre-release development and stable release gate

**Do not publish a stable GitHub, Visual Studio Marketplace, or Open VSX release until the official Scarp compiler has its first verified stable release.** Any change to this policy requires a separately reviewed update after testing against that stable compiler.

## Required setup

- Visual Studio Marketplace publisher and extension: `ScarpLang.scarp`. Register the OIDC **Trusted Publisher** policy for GitHub owner `scarp-lang`, repository `scarp-vscode`, workflow **`prerelease.yml`**, with no environment, under Marketplace publisher `ScarpLang`. No Marketplace PAT or `VSCE_PAT` secret is needed.
- Open VSX namespace and extension: `ScarpLang.scarp`. Create a publishing-only, extension-scoped Open VSX access token, and store it as the Actions repository secret **`OVSX_PAT`**. Never commit, print, or paste its value into logs or issues.
- The first Open VSX publication required a PAT. Open VSX already has the verified, published `ScarpLang.scarp` v0.1.1 pre-release, so the project now qualifies to configure **Trusted Publishing** (subject to the namespace owner's Publisher Agreement and registration).

### Open VSX Trusted Publishing migration (requires namespace owner action)

1. Sign in to Open VSX and open **Settings → Trusted Publishers**. Create a GitHub Actions trusted publisher for namespace `ScarpLang` and extension `scarp` (if the form requests it). Use **owner** `scarp-lang`, **repository** `scarp-vscode`, **workflow filename** `prerelease.yml`, and leave **environment** empty for the current workflow.
2. Review the registered policy. The workflow already requests `id-token: write` and restricts registry publishing to manually approved runs and published GitHub pre-releases.
3. In a separately reviewed GitHub PR, change the Open VSX step to `npx ovsx publish "$VSIX" --trusted-publishing` and remove all `OVSX_PAT` environment variables and token-presence checks. The PAT variable takes precedence over trusted publishing, so leaving it would prevent an actual migration.
4. Once the tokenless workflow is ready, remove the repository Actions secret `OVSX_PAT` and revoke the old token in Open VSX. Do **not** remove it before preparing the replacement workflow. Publish a **new version** to verify OIDC; do not republish the existing v0.1.1.
5. Confirm the published version reports `publishedWithTrustedPublishing: true` in its Open VSX metadata. If registration isn't configured, keep the currently working PAT-based workflow instead of publishing with broken credentials.

Because a trusted publisher is identified by GitHub repository/workflow identity, review any changes to `.github/workflows/prerelease.yml` carefully and keep main-branch protection enabled.
- Existing releases v0.1.0, v0.1.1, and v0.1.2 are experimental. Do not re-publish an already uploaded version: increment the three-part extension version for each new release.

## Publish an approved pre-release

Publishing requires an explicit human release action; routine pushes and pull requests never publish. There are two approved paths:

**A. Create/publish a GitHub pre-release in the Releases UI (both registries).**

1. Update and verify `package.json` version (e.g. `0.1.3`), commit and review changes, and verify compatibility against the official compiler.
2. Run CI and confirm that type checking, linting, unit tests, extension-host tests, compiler smoke tests, and package creation pass.
3. Create a GitHub Release marked **This is a pre-release**, using tag `v<package.json version>` at the reviewed commit.
4. The `release: published` event in `.github/workflows/prerelease.yml` builds and verifies the VSIX, attaches it to the GitHub release if missing, and **automatically publishes the same VSIX to both registries**. If the release already has a VSIX, the job downloads and validates that asset for both uploads.
5. Verify the new version appears as experimental/pre-release in Visual Studio Marketplace and Open VSX.

**B. Manually run the existing Actions workflow (optional registry publishing).**

1. Open **Actions → Publish experimental pre-release → Run workflow** from `main`.
2. Select `publish_marketplace` and/or `publish_openvsx` only if you explicitly approve publishing that version. Both options default to `false`.
3. The job tests/packages the version, creates or reuses the matching pre-release with a VSIX, and publishes only to the registries whose boxes are checked.
4. **GitHub Actions releases created using the default `GITHUB_TOKEN` do not trigger a second `release: published` workflow run.** Therefore, the manual workflow also performs the selected registry publishing directly.
5. Do not use this path to republish an unchanged version already present in a registry.

The pre-release packaging gate rejects VSIX archives containing internal workflow, compiler-checkout, test, or release-request files. In particular, approval marker files must remain in GitHub and **must not** ship inside the installed extension.

The shared release workflow confirms the GitHub tag matches the extension's numeric version, the release is flagged pre-release, and the VSIX contains `ScarpLang.scarp` with a pre-release marker. The official compiler smoke test is pinned to `v0.0.5-alpha.4` until a reviewed compatibility update.

**The PAT secret's existence cannot be verified by reading public repository files.** If `OVSX_PAT` is missing or empty, publishing fails before uploading to either registry.

## Pages

The optional static documentation page is deployed from `site/` on meaningful updates, not solely to increase visible deployment activity.
