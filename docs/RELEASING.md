# Pre-release development and stable release gate

**Never publish a stable GitHub or Visual Studio Marketplace release before the official Scarp compiler first publishes a stable release.** After that milestone, verify stable compiler compatibility, critical functionality, bugs, docs and packaging before changing this policy.

## First experimental 0.1.0 candidate

1. Complete CI type checking, linting, unit tests and VSIX packaging.
2. Validate run/check against a pinned real Scarp compiler pre-release.
3. The first merge to main automatically triggers the **Publish experimental pre-release** workflow. It independently tests, packages, and creates a GitHub Release marked Pre-release, with a VSIX attached. The workflow can also be run manually.
4. Marketplace publication requires an active **Trusted Publishing** policy under publisher `ScarpLang`: GitHub owner `scarp-lang`, repository `scarp-vscode`, workflow `prerelease.yml`, with the environment field empty. The job requests `id-token: write` and uses `npx vsce publish --pre-release --no-dependencies --oidc`. No PAT is required.
5. After manually verifying the VSIX, use the **Actions → Publish experimental pre-release → Run workflow** control on `main` with `publish_marketplace=true`. Normal pushes must never publish to the Marketplace automatically.
6. After a successful run, verify that `ScarpLang.scarp` is listed and flagged as a pre-release on the Marketplace.
7. Open VSX publication is deferred until its separate `ScarpLang` namespace is approved and the publishing approach is confirmed.
8. Do not inflate deployments, PR counts or commits artificially.

VS Code Marketplace uses three-part numeric versions such as 0.1.0; the vsce pre-release flag sets pre-release classification. A later stable extension must use a distinct version and obey the compiler stability gate.

## Pages

The optional static documentation page is deployed from site/ on meaningful updates, not solely to increase visible deployment activity.
