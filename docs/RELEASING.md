# Pre-release development and stable release gate

**Never publish a stable GitHub or Visual Studio Marketplace release before the official Scarp compiler first publishes a stable release.** After that milestone, verify stable compiler compatibility, critical functionality, bugs, docs and packaging before changing this policy.

## First experimental 0.1.0 candidate

1. Complete CI type checking, linting, unit tests and VSIX packaging.
2. Validate run/check against a pinned real Scarp compiler pre-release.
3. The first merge to main automatically triggers the **Publish experimental pre-release** workflow. It independently tests, packages, and creates a GitHub Release marked Pre-release, with a VSIX attached. The workflow can also be run manually.
4. Marketplace publication additionally requires a secure VS_MARKETPLACE_PAT repository secret and explicit opt-in. Always use the --pre-release vsce flag.
5. Open VSX publication is deferred until the correct publisher namespace and instructions are supplied.
6. Do not inflate deployments, PR counts or commits artificially.

VS Code Marketplace uses three-part numeric versions such as 0.1.0; the vsce pre-release flag sets pre-release classification. A later stable extension must use a distinct version and obey the compiler stability gate.

## Pages

The optional static documentation page is deployed from site/ on meaningful updates, not solely to increase visible deployment activity.
