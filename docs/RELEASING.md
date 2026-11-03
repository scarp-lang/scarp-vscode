# Pre-release development and stable release gate

**Do not publish a stable GitHub, Visual Studio Marketplace, or Open VSX release until the official Scarp compiler has its first verified stable release.** Any change to this policy requires a separately reviewed update after testing against that stable compiler.

## Required setup

- Visual Studio Marketplace publisher and extension: `ScarpLang.scarp`. Register the OIDC **Trusted Publisher** policy for GitHub owner `scarp-lang`, repository `scarp-vscode`, workflow **`prerelease.yml`**, with no environment, under Marketplace publisher `ScarpLang`. No Marketplace PAT or `VSCE_PAT` secret is needed.
- Open VSX namespace and extension: `ScarpLang.scarp`. Create a publishing-only, extension-scoped Open VSX access token, and store it as the Actions repository secret **`OVSX_PAT`**. Never commit, print, or paste its value into logs or issues.
- The first Open VSX publication requires a PAT. Once there is an active Open VSX version, you may switch to Open VSX Trusted Publishing by registering `scarp-lang/scarp-vscode` and workflow `prerelease.yml` in Open VSX, replacing the PAT-based step with `ovsx publish --trusted-publishing`, and removing `OVSX_PAT`.
- Existing release v0.1.0 is experimental. Do not re-publish an already uploaded version: increment the three-part extension version for each new release.

## Publish an approved pre-release

Publishing requires an explicit human release action; routine pushes and pull requests never publish. There are two approved paths:

**A. Create/publish a GitHub pre-release in the Releases UI (both registries).**

1. Update and verify `package.json` version (e.g. `0.1.1`), commit and review changes, and verify compatibility against the official compiler.
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

**Approved one-time v0.1.1 release:** The maintainer explicitly requested this next pre-release. After PR checks pass and the implementation is merged to `main`, create `release-requests/v0.1.1.approved` with the exact content `scarp-vscode v0.1.1 experimental pre-release approved` using the exact commit message `release: approve Scarp extension v0.1.1 pre-release`. Only that path and message trigger the one-time push publishing gate. The workflow builds, tests, creates the GitHub pre-release, and attempts both registries. This is not enabled for ordinary commits or future versions. Check the Actions logs and registry listings afterward; never assume publishing succeeded from the commit alone.

The pre-release packaging gate rejects VSIX archives containing internal workflow, compiler-checkout, test, or release-request files. In particular, approval marker files must remain in GitHub and **must not** ship inside the installed extension.

The shared release workflow confirms the GitHub tag matches the extension's numeric version, the release is flagged pre-release, and the VSIX contains `ScarpLang.scarp` with a pre-release marker. The official compiler smoke test is pinned to `v0.0.5-alpha.3` until a reviewed compatibility update.

**The PAT secret's existence cannot be verified by reading public repository files.** If `OVSX_PAT` is missing or empty, publishing fails before uploading to either registry.

## Pages

The optional static documentation page is deployed from `site/` on meaningful updates, not solely to increase visible deployment activity.
