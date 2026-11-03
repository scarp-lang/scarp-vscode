# Changelog

## Unreleased — main branch development

- Add opt-in `scarp.verifyOnSave` (default **false**) with safe, non-executing compiler verification after saving local `.srp` documents in trusted workspaces.
- Debounce rapid saves per file, serialize overlapping checks, deduplicate manual-save checks, and skip stale document revisions.
- Keep automatic diagnostics quiet in Problems/Output instead of showing popups or launching terminals.
- Never automatically run the legacy evaluating `check` command on older compiler versions.
- Add scheduler unit tests and real VS Code Extension Host coverage against the official pinned compiler.
- Keep release publishing gated to approved experimental versions.

## v0.1.2 — experimental pre-release (2026-11-03)

- Introduce native Scarp syntax highlighting via a TextMate grammar based on the released Scarp v0.0.5-alpha.3 lexer/parser.
- Highlight `funcra` function declarations, `bind`/`var` declarations, control flow, built-in output calls, primitives, numbers, strings, escapes, operators and line comments.
- Add real TextMate/Oniguruma tokenization tests, with coverage for strings containing comment markers, multiline recovery and longest operators.
- Include the grammar inside the verified pre-release VSIX, with CI and publish-time package content checks.
- Ship the earlier merged independent per-file Problems lifecycle and stale-diagnostics fixes.

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

GitHub v0.1.2 is an experimental pre-release, published with verified Visual Studio Marketplace and Open VSX upload steps; it is not a stable extension.

Marketplace pre-release: https://marketplace.visualstudio.com/items?itemName=ScarpLang.scarp

Publication was verified through the GitHub Actions OIDC workflow. This does not make the Scarp compiler or the extension stable.
