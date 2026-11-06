# Changelog

## Unreleased — v0.1.5 development

- Guard manually dispatched experimental publication against a pre-existing `vVERSION` Git tag pointing at a different commit than the verified `main` checkout. Refresh remote tags and reject mismatched lightweight or annotated tags **before packaging or attaching a VSIX**. A missing tag may be created from the approved SHA; a matching tag can be reused. Exercise real temporary Git repositories in cross-platform release-policy tests.

- Stop obsolete **project** verification subprocesses on in-editor Scarp source/manifest edits or `scarp.compilerPath` changes. Scope cancellation to the affected explicit project root, including version and capability probes, while retaining disk-snapshot verification for external edits and keeping unrelated files, projects and Run terminals independent. Test a SIGTERM-resistant project compiler inside a real VS Code Extension Host and preserve unrelated completed Problems.

- Terminate obsolete file-verification subprocesses promptly when the checked document is edited/closed or `scarp.compilerPath` changes. Wire a scoped `AbortSignal` through executable validation, static capability probing and actual verify/check execution. Prevent cancelled checks from publishing Problems, suppress spurious cancellation popups, and leave project checks, terminals and other files' completed diagnostics untouched. Add real VS Code Extension Host regression coverage using a stubborn compiler wrapper.


- Add real VS Code Extension Host regression coverage for overlapping verify-on-save operations: an active compiler process, an expired older rerun, and a newer pending debounce must verify the newest saved source only. Verify the real pinned Scarp compiler also diagnoses the final file after rapid consecutive saves, without spawning a terminal; when an obsolete check is canceled early, an intermediate saved version may be checked before the latest save arrives.

- Preserve the **newest** save request when an older debounced rerun is waiting on an active verification. An older rerun can no longer cancel a newer save's pending timer when the active check completes. Keep same-file verification serialized, independent files unaffected, and support generic task payloads whose value is `undefined`.

- Cancel pending compiler-backed Go to Definition / Find All References requests promptly using VS Code cancellation tokens and a bounded SIGTERM/SIGKILL child-process shutdown. Abort stale inspections when `scarp.compilerPath` changes, suppress results from the previous executable, and dispose listeners on all outcomes. Cover pre-cancelled and running subprocesses, finished-process cancellation, and real Extension Host navigation races with compiler switches.

- Fix ZIP archive release comparison for literal names such as `[Content_Types].xml`, and reject duplicate member names. The old `unzip -p` wildcard behavior could silently compare empty outputs for a required VSIX metadata file. Compare all exact uncompressed bytes with a bounded-memory streaming SHA-256 check instead, and exercise both tampered XML and duplicate-member regressions in CI.

## v0.1.4 — Experimental pre-release (2026-11-06)


- Cancel in-flight static verification and pending file/project Run startups when `scarp.compilerPath` changes. Prevent the previous executable from adding fresh Problems or opening a delayed terminal after the setting changes. Preserve previously completed Problems when a compiler is missing until a new check or source edit updates them.

- Bound runaway Scarp CLI subprocesses: after a timeout or output-size violation, request graceful termination and then force-kill a stubborn compiler that ignores the first signal. Reject invalid output-byte limits before spawning. Add regression tests for both timeout and output overflow with SIGTERM-resistant children.

- Require both **trusted** and **Restricted Mode** real VS Code Extension Host suites to pass on the exact approved release/tag checkout before VSIX packaging, GitHub release attachment or registry publication. The workflow no longer relies exclusively on earlier PR CI for editor integration.
- Exclude downloaded `.vscode-test/` editor binaries from installable VSIX packages and reject archives containing them; cover the release gating order and package exclusions with policy regression tests.

- Add explicitly limited Workspace Trust support: read-only syntax and local Outline remain available in Restricted Mode while compiler and execution commands stay blocked (including direct invocation) and their editor/Command Palette entries are hidden. Add a separate Linux VS Code Extension Host run with fresh user data that proves the workspace is genuinely untrusted and no executable or terminal is started.

- Add real VS Code Extension Host coverage for compiler errors in imported `.srp` files, routing Problems to the imported document, clearing them after a successful recheck, missing executable failure without false success or terminal startup, and direct argv-safe terminal launches from paths containing spaces.

- Serialize in-flight **Run Current File** and **Launch Project** startup so simultaneous commands cannot open duplicate terminals. **Stop Running Program** also cancels pending compiler probes or folder selection before any terminal is created; keep independent file/project sessions intact.
- Add real VS Code Extension Host regressions for concurrent file/project launches and Stop during a delayed compiler version probe.

- Harden **Scarp: Browse Project Modules** with bounded source snapshots before CLI capability detection, after static inspection, after Quick Pick selection and immediately before editor opening. Reject externally modified imports/manifest, dirty buffers and stale clean editor documents rather than opening an invalid source inventory.
- Add a real VS Code Extension Host regression that wraps the released Scarp compiler, holds a valid static module inventory and modifies another saved source during the response; no stale Quick Pick may be shown.

- Add **Scarp: Browse Project Symbols** using the officially published v0.0.6-alpha.1 `inspect symbols --json` schema. Search statically verified project declarations from a Quick Pick and jump to the source with canonical path, strict UTF-8 byte/Unicode column and disk-snapshot validation. Unsupported compilers, stale source changes and unsaved buffers fail closed.
- Share the parser's bounded schema-v1 file/symbol validation across both symbol and reference views; add schema contract tests and a real-compiler Extension Host symbol inventory smoke test.

- Guard compiler-backed Go to Definition and Find All References with bounded SHA-256 source snapshots before inspection, after the CLI completes and before returning VS Code locations. Detect changes to imported modules and standalone files made outside the editor; reject stale/unreloaded buffers and coordinates whose byte offsets disagree with the compiler.
- Extend the existing trusted project snapshot mechanism to non-project Scarp source roots without weakening the project manifest check. Add regression tests for standalone import changes and new files.

- Integrate the newly published Scarp compiler **v0.0.6-alpha.1** static source index with on-demand VS Code **Go to Definition** and **Find All References** across project files. Validate schema-v1 reference metadata, file ownership and UTF-8/UTF-16 coordinates; do not execute source, cache snapshot IDs, or guess on unsupported compilers.
- Pin real-compiler CI/release smoke tests and Extension Host integration to v0.0.6-alpha.1, including `inspect references --json` checks. Preserve the current experimental-only publishing gate.

- Add **Scarp: Browse Project Modules** with a read-only Quick Pick backed by the published Scarp alpha.5 `inspect modules --json PROJECT_DIRECTORY` contract. Open the selected project source without executing Scarp statements.
- Validate schema-v1 inventory, bounded module/import/symbol counts, canonical project containment and symlink-safe opening; reject dirty editor inputs and document CLI errors. Cover malformed inventories and real compiler integration.

- Align cross-platform CI and release readiness with the published Scarp v0.0.5-alpha.5 compiler. Smoke-test canonical `verify` and `exec`, project launch and read-only project module JSON inspection.
- Harden experimental publishing: check out the approved GitHub release tag reachable from protected main, validate the compiled VSIX identity and pre-release marker before attachment, reject leaking internal source/scripts, and compare pre-attached release asset contents against the reviewed build before dual-registry publishing.
- Share release package checks and add CI tampering regression coverage. Prepare experimental v0.1.4 release notes without tagging or publishing.

- Reconcile previously verified project source hashes when VS Code regains focus, or via **Scarp: Check Verified Project Diagnostic Freshness**. Clear stale per-project Problems if a filesystem watcher missed an external change; never run the compiler automatically.
- Coalesce overlapping focus scans, prevent stale scan results from invalidating a newer verification, and treat missing/unreadable files as stale. Add focused unit tests and a VS Code Extension Host regression.

- Monitor at most eight explicitly verified Scarp project roots with VS Code filesystem watchers and a bounded native recursive fallback when supported; after verification, invalidate outdated Problems on external `.srp` or root-manifest file events without automatically recompiling or executing code.
- Dispose watchers after invalidation, re-verification or extension shutdown; evict oldest watchers and clear their project-owned diagnostics when at capacity. Cover lifecycle and real Extension Host external-file events.

- Reject project diagnostic results if a bounded local disk snapshot of `.srp` sources or `Scarp.project` changes during compiler verification, including edits from other processes, new files and deletions.
- Fail closed for unmonitored symlinked directories and excessive project-tree sizes; keep unchanged and unrelated files from invalidating checks.
- Add cross-platform disk snapshot unit tests and delayed external-disk-change VS Code Extension Host regression tests.

- Clear completed project verification diagnostics when any local `.srp` or `Scarp.project` editor buffer changes, including previously clean files. Preserve independent verification owners and avoid clearing for unrelated sibling directories or Markdown edits.
- Cover project-wide invalidation in unit tests and the real VS Code Extension Host.

- Prevent project verification from publishing stale Problems when an open source file, imported module or `Scarp.project` changes while the compiler runs.
- Reject dirty project source/manifest buffers and overlapping verifications of the same project root, rather than checking a different on-disk snapshot.
- Add path containment and edit lifecycle unit tests plus a delayed-compiler VS Code Extension Host regression for source and manifest edits.

- Prefer the official Scarp-first `exec` command when supported, while retaining the historical `run` fallback for older compilers.
- Preserve multi-byte Unicode in compiler stdout/stderr even when OS pipes split a UTF-8 character between chunks.
- Cover canonical command detection with the pinned real Scarp compiler, Unicode process output and legacy command fallback.
- Update compiler smoke tests and pre-release development packaging to v0.1.4 without publishing another version.

## v0.1.3 — experimental pre-release (2026-11-04)

- Integrate the newly released Scarp compiler **v0.0.5-alpha.4** project workflow: create, static verify and launch an explicit `Scarp.project` directory without shell interpolation.
- Gate new project actions on the real `scarp diagnose --json` `project_workflow` capability instead of guessing from a version string.
- Add safe project naming and explicit root selection; use a real interpreter terminal for project launch and compiler-backed Problems for static project errors.
- Upgrade compiler smoke tests, cross-platform extension-host integration and prerelease compatibility checks to published alpha.4.
- Add the official `--max-text-bytes` interpreter budget as `scarp.maxTextBytes` for file runs and project launching.
- Add VS Code Outline and **Go to Symbol in Editor** for file-scope Scarp functions, public exports, bindings, mutable variables and aliased imports.
- Provide an error-tolerant Scarp token scanner that ignores fake declarations in comments/strings, tracks function body ranges, and avoids compiler execution.
- Cover document symbol extraction with unit tests and the real VS Code Extension Host.
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

GitHub v0.1.3 is the latest experimental pre-release, published with verified Visual Studio Marketplace and Open VSX upload steps; it is not a stable extension.

Marketplace pre-release: https://marketplace.visualstudio.com/items?itemName=ScarpLang.scarp

Publication was verified through the GitHub Actions OIDC workflow. This does not make the Scarp compiler or the extension stable.
