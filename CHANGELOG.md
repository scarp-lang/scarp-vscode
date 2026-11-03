# Changelog

## Unreleased — main branch development

- Preserve independent Scarp Problems across multiple source verifications.
- Clear stale diagnostics when a source is edited without deleting unrelated file errors.
- Discard verification results if the source changed during compilation.
- Add unit and real VS Code Extension Host integration coverage for multi-file diagnostics.

- Keep experimental-only release protection and dual-registry publishing for approved GitHub pre-releases.

## v0.1.1 — experimental pre-release (2026-11-03)

- Use static-only `scarp verify` when supported by the installed compiler; older versions retain the legacy evaluating `check` fallback.
- Parse compiler schema-v1 JSON diagnostic coordinates, code, optional help, and source ranges into Problems.
- Add integration coverage proving a statically valid expression is not executed during verification.
- Update CI and the release smoke test to the released Scarp compiler v0.0.5-alpha.3.

- Add automated VS Code Extension Host integration checks against a real pinned Scarp compiler.
- Make commands awaitable for reliable editor integration verification.
- Disable automatic GitHub pre-release workflow triggers on routine pushes to main; releases require an explicit manual dispatch.

## v0.1.0 — experimental pre-release (2026-11-02)

- Initial TypeScript extension for Scarp .srp files.
- Official compiler version detection, interactive run and check integration.
- Problems diagnostics, Output channel, resource limit settings and Stop command.
- Automated unit tests, planned real-compiler CI and experimental VSIX packaging.

The changelog does not imply that a release or deployment has occurred.

Marketplace pre-release: https://marketplace.visualstudio.com/items?itemName=ScarpLang.scarp

Publication was verified through the GitHub Actions OIDC workflow. This does not make the Scarp compiler or the extension stable.
