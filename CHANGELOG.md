# Changelog

## Unreleased — main branch development

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
