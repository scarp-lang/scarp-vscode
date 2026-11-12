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
- Existing releases v0.1.0 through v0.1.4 are experimental pre-releases. Do not re-publish an already uploaded version: increment the three-part extension version for each new release.

## Tag origin and release-asset integrity
- Independently validate every new VSIX **before its first GitHub upload**,
  including the ZIP member inventory, duplicate member names, traversal paths,
  symlinks, encrypted entries and required `[Content_Types].xml` metadata.
  The release asset comparator checks existing uploads separately. CI proves
  that malicious archive mutations are rejected by the first-upload validator.
- Manually dispatched publishing from `main` also fetches current remote
  tags and refuses to package when an existing version tag points at a
  different commit. Both lightweight and annotated tags resolve to their
  underlying commit. If no version tag exists, the reviewed workflow can
  create it from its exact checked-out commit. An old pre-release tag must
  never silently be reused for a later untagged build.

- For an approved published GitHub **pre-release**, the workflow explicitly
  checks out the release's **tagged commit**, not the current tip of `main`.
  It rejects a tag whose commit is not reachable from protected `main`.
- Source verification, official compiler tests, typechecking, linting, unit
  tests and package validation run before a new VSIX is attached to a release.
- The publishing workflow independently runs **both** real Linux VS Code Extension Host suites against the checked-out approved revision before packaging or uploading: the trusted host uses published compiler **v0.0.6-alpha.7**, checking exact Top-K, temperature-softmax, sampled-calculus, cosine-similarity, nucleus-selection, Pearson-correlation, text and tuple example output and redirected UTF-8 input; the Restricted Mode host confirms that no compiler can be invoked in an untrusted folder. CI retains separate alpha.1–alpha.7 compatibility checks. The publish runner needs `xvfb-run`; earlier PR CI checks alone are not enough to pass the release gate.
- CI-generated `.vscode-test/` editor installations are excluded from the VSIX; the package validator also rejects a VSIX that contains this directory.
  A downloaded GitHub release VSIX is validated again after download.
- When a release already contains `scarp-VERSION.vsix`, the shared
  `scripts/compare-vsix.sh` gate compares the exact ZIP member names and
  uncompressed payload bytes against the locally rebuilt package. It uses
  literal ZIP entry access (not `unzip -p` wildcard matching), so mandatory
  entries such as `[Content_Types].xml` cannot be silently skipped. Duplicate
  member names, changed bytes and extra or missing entries are **rejected**
  before either registry upload. Equivalent content with different ZIP
  timestamps or compression settings remains acceptable.
- Release scripts live only in the source repository and are excluded from
  the installable VSIX. CI verifies that the comparator detects tampering.

These checks are safety gates, not authorization to publish. Do not create
a release/tag unless the version and compiler compatibility have been
reviewed, and always mark GitHub and registry publication as **pre-release**.

**Public release notes gate:** When a manually dispatched workflow creates
a new GitHub release, it requires a reviewed
`docs/releases/vVERSION-public.md` matching the requested `vVERSION` tag.
The long-form `docs/releases/vVERSION.md` may remain a development draft and
must not be used as public release copy. Missing public notes fail closed
before this workflow creates a release. A release created directly through
GitHub's Releases UI uses the notes supplied in that UI; review those notes
before publishing. A successful qualification-only run does not constitute
publication approval.

## Publish an approved pre-release

Publishing requires an explicit human release action; routine pushes and pull requests never publish. There are two approved paths:

**A. Create/publish a GitHub pre-release in the Releases UI (both registries).**

1. Update and verify `package.json` version (e.g. `0.1.6`), commit and review changes, and verify compatibility against the official compiler.
2. Run CI and confirm that type checking, linting, unit tests, extension-host tests, compiler smoke tests, and package creation pass.
3. Create a GitHub Release marked **This is a pre-release**, using tag `v<package.json version>` at the reviewed commit.
4. The `release: published` event in `.github/workflows/prerelease.yml` builds and verifies the VSIX, attaches it to the GitHub release if missing, and **automatically publishes the same VSIX to both registries**. If the release already has a VSIX, the job downloads and validates that asset for both uploads.
5. Verify the new version appears as experimental/pre-release in Visual Studio Marketplace and Open VSX.

**B. Manually run the Actions workflow (qualification-only by default).**

1. Open **Actions → Publish experimental pre-release → Run workflow** from `main`.
2. Leave **`publish_github`, `publish_marketplace`, and `publish_openvsx` all unchecked** to qualify the next development version without publishing. This default runs the same compiler smoke, type/lint/unit, trusted and Restricted Mode editor-host, and VSIX validation gates. The validated VSIX is saved only as a **7-day GitHub Actions run artifact**; it is **not** a GitHub Release or registry upload.
3. Only if explicitly approving a public experimental release, check **`publish_github`**. The workflow creates or verifies the version-matched pre-release and attaches the validated VSIX.
4. To also publish to Visual Studio Marketplace or Open VSX, check `publish_marketplace` and/or `publish_openvsx` **in addition to `publish_github`**. A registry selection without GitHub release approval fails before any compiler work.
5. **GitHub Actions releases created using the default `GITHUB_TOKEN` do not trigger a second `release: published` workflow run.** Therefore, the approved manual workflow performs the separately selected registry publishing directly.
6. Do not use this path to republish an unchanged version already present in a registry. Every new public release must remain experimental.

The shared `scripts/verify-vsix.sh` pre-release packaging gate checks the package publisher, extension ID, numeric version, compiled entrypoint, grammar and the VS Code pre-release marker. It rejects VSIX archives containing internal workflow, compiler-checkout, test, source, scripts or release-request files. In particular, approval marker files must remain in GitHub and **must not** ship inside the installed extension.

The shared release workflow confirms the GitHub tag matches the extension's numeric version, the release is flagged pre-release, and the VSIX contains `ScarpLang.scarp` with a pre-release marker. The release workflow independently builds and checks the published `v0.0.6-alpha.7` compiler, including `verify`, `exec`, project creation/verification/launch, read-only `inspect modules --json PROJECT_DIRECTORY`, static references, and exact alpha.3–alpha.7 scientific, text, tuple, redirected-input and conditional-Unicode fixtures. CI retains separately pinned alpha.1–alpha.7 compiler checks with real VS Code Extension Host integration. This does **not** imply that native executable generation is available.

**The PAT secret's existence cannot be verified by reading public repository files.** If Open VSX publishing is requested and `OVSX_PAT` is missing or empty, the workflow fails before compiler qualification, VSIX creation or any GitHub pre-release asset upload. An existing GitHub pre-release published externally still requires the secret for the registry step.

## Pages

The optional static documentation page is deployed from `site/` on meaningful updates, not solely to increase visible deployment activity.
