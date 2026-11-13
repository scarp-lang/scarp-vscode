# Changelog

## Unreleased — v0.1.6 development

- Add explicit compiler-backed diagnostic explanations via the published `scarp explain E####` contract: a Quick Fix action on verified Scarp Problems and a Command Palette entry. Strictly validate exact uppercase codes, never invoke a shell or modify source, and guard Workspace Trust and compiler configuration changes. Add unit tests plus real compiler and Restricted Mode Extension Host coverage; this is development work only, not an extension pre-release.

- Introduce opt-in `Scarp: Initialize Modern Project` via the published alpha.8 `scarp init` contract. It checks the installed compiler's `guide init` capability before creating a fresh declarative `scarp.project` project, keeps the original legacy Create Project command and never overwrites existing paths or runs source.

- Add opt-in `Scarp: List Project Tests` using the published alpha.8 compiler's read-only `--json --list` contract. Strictly validate schema v1 and project-local test file names, retain bounded disk snapshots around inspection and Quick Pick navigation, and refuse untrusted or unsaved projects. No Scarp source execution occurs during listing.

- Prepare compiler alpha.8 project testing integration: add an explicit trusted-workspace `Scarp: Run Project Tests` command that probes `guide test`, rejects unsaved source and test input fixtures, and uses bounded source/fixture snapshots before terminal launch. No automatic test execution, release, or native build is introduced. Add real VS Code Extension Host command coverage, and a separate immutable alpha.8 compiler CI gate for declarative project initialization, assertions, input fixtures, filtered test execution, JSON reports and read-only discovery.

- Add opt-in, per-file Run/Verify CodeLens actions for local `.srp` documents, disabled by default and unavailable in Restricted Mode. Bind each action to its explicit source URI rather than the active tab, and revalidate trust and source type when invoked. Source browsing never launches the compiler or adds background watchers.

- Add conservative Scarp builtin IntelliSense suggestions based on the same immutable 18-function metadata used by Hover and Signature Help. Prefix filtering avoids quoted text, `//` comments, function/binding/import declarations and member calls; run entirely in the editor in trusted and Restricted Mode with real Extension Host integration coverage.

- Add bounded, compiler-free signature help for 18 published numerical/text/input built-in calls in both trusted and Restricted Mode. Follow nested expression argument positions, avoid source execution and keep semantic correctness delegated to the official compiler.

## v0.1.5 — 2026-11-12 experimental pre-release

- Move the scoped Open VSX token-presence gate ahead of compiler qualification and public GitHub release creation. A missing secret now fails before publication instead of leaving a new GitHub pre-release stranded without its requested registries; qualification-only runs still require no token.

- Validate compiler-inspected module graph edges before browsing: reject dangling import target IDs even when a JSON inventory otherwise has valid paths and counts. Preserve forward references within the inventory and all project-root containment checks.

- Improve native VS Code editing: retain compiler-valid `//` line comments for Toggle Line Comment, add conservative brace indentation and foldable `// #region` / `// #endregion` markers. Guard regex behavior with unit tests and prove actual comment toggle/restore in a real VS Code Extension Host.

- Qualify the exact published Scarp v0.0.6-alpha.7 compiler in the guarded pre-release workflow, including its immutable source commit, interpreter-only conditional-value and Unicode-scalar escape fixture, and all 14 editor snippets. Retain the independent compiler alpha.1–alpha.7 compatibility jobs and both trusted/Restricted Mode Extension Host release gates. No stable release is permitted.

- Add compiler-independent hover help for the 11 scientific built-ins published across Scarp alpha.3–alpha.5: show typed signatures, version requirements and domain constraints only at actual unqualified call sites. Skip comments, strings, function declarations and similarly named identifiers with bounded lexical checks. Register a non-executing VS Code Hover provider in both trusted and Restricted Mode; add unit, real Extension Host and Restricted Mode tests. No language server, background indexing or new compiler invocation is introduced.

- Qualify the published Scarp **v0.0.6-alpha.5** compiler independently of retained alpha.1–alpha.4 CI: build the tagged official CLI, validate project and reference inspection, compare nucleus-selection and Pearson-correlation examples against exact expected output, and run the real Linux VS Code Extension Host suite. Align the manual, opt-in experimental pre-release qualification gate to alpha.5 without automatically publishing. Highlight `top_p`, `top_p_values`, and `pearson_correlation` only in true calls with tokenizer checks for comments, strings, longer identifiers and declarations.

- Add the published Scarp v0.0.6-alpha.4 compatibility gate while preserving alpha.1–alpha.3 CI. Test official sampled calculus, cumulative area and cosine similarity examples with exact stdout and a real VS Code Extension Host. Pin the guarded experimental-only release qualification to alpha.4; **do not publish** automatically. Highlight `cosine_similarity` in the compiler's TextMate call grammar and update documented compiler support.

- Clarify version support for editor-only `sample_area` and `sample_slopes` highlighting. These names are available in unreleased Scarp compiler `main` after v0.0.6-alpha.3, not in the published alpha.3 binaries. Release notes must not misrepresent highlighting as executable compiler functionality.

- Highlight the official v0.0.6-alpha.3 numerical built-ins (`topk`, `topk_values`, `softmax_temp`, `logsoftmax_temp`) as editor-only Scarp function calls. The real TextMate tokenizer test asserts comments, strings, longer identifiers and user function declarations are not mistakenly styled as built-in invocations. Syntax highlighting does not imply these calls are supported on older installed compiler versions.

- Qualify published Scarp compiler **v0.0.6-alpha.3** with an independent Linux CLI and VS Code Extension Host CI gate while retaining alpha.1 and alpha.2 compatibility. Validate module/reference schema and verify and execute immutable alpha.3 Top-K and temperature examples against exact expected stdout. Pin the experimental pre-release qualification workflow to alpha.3 without automatically publishing, tagging, or implying stable/native compilation.

- Prevent **Run Current File** from opening a terminal for a saved `.srp` source externally rewritten while the compiler version or `guide exec` capability probes are running. Reuse the bounded selected-source disk fingerprint and revalidate it immediately before terminal creation. Preserve cancellation on in-editor edits, Stop and compiler switches, and leave unrelated sibling files independent. Add real VS Code Extension Host regressions for both startup phases and successful Run after a sibling-only change.


- Qualify the newly published Scarp **v0.0.6-alpha.2** compiler against the VS Code extension's real CLI contract and trusted VS Code Extension Host, without removing pinned alpha.1 backwards-compatibility CI checks or changing protected-branch check names. Update the experimental-only release gate to build and verify alpha.2, retain module/reference JSON shape verification and version assertions, and clarify that alpha.2's new optional Rust embedding caches do not implement a language server or CLI native compilation. No extension release is published by this work.


- Guard standalone **Verify Current File** and opt-in **Verify on Save** against external changes to the selected saved `.srp` source during a compiler run. Compute a bounded, streaming SHA-256 source fingerprint with stable file metadata before compiler detection, again before accepting results, and while applying Problems. Discard obsolete output rather than trusting an unchanged VS Code document version. A single-file scope avoids recursively traversing unrelated monorepos; other sibling files and unrelated verifications remain independent. Unit and real Extension Host tests exercise external rewrites, restored mtimes, symlinks and recovery after a fresh verification.


- Prevent stale **Launch Project** terminals: reject unsaved Scarp source/manifest buffers, snapshot the explicitly selected project before compiler capability detection and recheck the saved source tree immediately before opening a terminal. Abort in-flight version/capability probes on source edits, Stop or compiler changes; detect external filesystem rewrites using bounded SHA-256 snapshots, while unrelated projects remain independent. Test all paths in a real VS Code Extension Host with a SIGTERM-resistant fake compiler.


- Abort obsolete **Go to Definition / Find All References** compiler inspections as soon as any open `.srp` source or `Scarp.project` manifest in the selected navigation root is edited. Cancel when the requested document closes, while leaving other source roots, standalone checks and Run terminals untouched. Recheck dirty buffers after snapshot capture to close the listener-registration race; use the existing bounded SIGTERM/SIGKILL shutdown. Add real VS Code Extension Host tests for stubborn compiler cancellation on source/import edits and successful navigation after an unrelated edit.


- Stop stale **Run Current File** startups if the saved editor document is edited or closed during compiler version or execution-command probing. Cancel the actual pending child process (including SIGTERM-resistant probes) on source changes, Stop and compiler switches, and prevent a terminal from launching an older saved version. Keep running terminals and unrelated documents unaffected; add real VS Code Extension Host regressions for edits during both probes and Stop.

- Stop active **automatic verify-on-save** compiler processes when `scarp.verifyOnSave` is switched off, respecting resource-scoped overrides and skipping any stale automatic diagnostics. Explicit **Verify Current File** checks continue independently when that setting changes. Add a real VS Code Extension Host test with a SIGTERM-resistant compiler for both cases.

- Make manual pre-release workflow invocations **qualification-only by default**, without creating a public GitHub release. After compiler, trusted/Restricted Mode editor, unit, packaging and VSIX safety checks, upload the validated VSIX as a short-lived Actions artifact. Creating a public pre-release requires an explicit `publish_github` opt-in, and either registry option requires that GitHub release approval. Preserve the existing approved GitHub pre-release event publishing behavior.

- Strengthen the **first-upload** experimental VSIX verifier: reject duplicate ZIP entries, path traversal or absolute member names, symlinked/encrypted members, and missing `[Content_Types].xml` before GitHub attachment or registry publication. The older byte-for-byte comparator still protects pre-attached release assets. CI rebuilds tampered candidate archives to prove each refusal.

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
