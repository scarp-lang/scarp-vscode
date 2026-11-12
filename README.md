# Scarp Compiler & Runner

Official Visual Studio Code extension for the [Scarp language](https://github.com/scarp-lang/scarp). This is **experimental pre-release software** that calls the actual Scarp compiler; it does not reimplement the language.

> Never publish a stable extension until the Scarp programming language/compiler publishes its first verified stable release.

## Implemented

- **14 opt-in Scarp snippets:** type `sprint`, `sbind`, `svar`, `sif`, `sifelse`, `srepeat`, `swhile`, `sfunc`, `spurefunc`, `stuple`, `sread`, `stextint`, or `stextfloat`, or `sconditional` in a `.srp` document. These are text expansions, statically compiler-checked in CI, not semantic completion. Alpha.6 templates state their minimum version and redirected-input requirements.
- Recognize .srp files as Scarp, with a real TextMate grammar for the current Scarp compiler's declarations, functions, types, control flow, strings, numeric literals, operators, and line comments.
- **Native Scarp editing:** use VS Code's normal **Toggle Line Comment** shortcut (`Ctrl+/` on Windows/Linux, `Cmd+/` on macOS) to add or remove `//` without a custom keybinding; Scarp has no supported block comment syntax. Brace-aware editor rules indent lines after an opening `{` and dedent closing `}` lines, including Enter between braces. Wrap sections in `// #region NAME` and `// #endregion NAME` to fold them. These are editor-only conveniences; the official compiler still defines syntax and execution.
- **Optional file action CodeLens (v0.1.6 development):** enable `scarp.showFileActionsCodeLens` (off by default) to show **Run Scarp File** and **Verify Scarp File** directly above each local `.srp` document. Each action explicitly targets that file, even if the active editor changes. Merely displaying the lenses never executes code; the existing command handlers enforce Workspace Trust and check the target. The Verify command uses non-executing `verify` when supported, but older compilers may fall back to evaluating `check`. Disabled entirely in Restricted Mode.
- **Scarp: Run Current File:** launch the official compiler in the integrated terminal with program input/output. Prefer canonical `scarp exec` when the installed compiler advertises `scarp guide exec`, and retain legacy `scarp run` for older compiler versions.
- **Scarp: Verify Current File:** use the compiler's non-executing `verify` command when supported (Scarp v0.0.5-alpha.3+), including source-span JSON diagnostics in Problems. Older compilers fall back to the legacy evaluating `check` command.
- **Scarp: Show Compiler Version:** verify the executable.
- **Scarp: Stop Running Program:** stop extension-owned terminal sessions and cancel file/project starts that are still waiting for compiler detection. Duplicate Run or Launch commands for the same source/project cannot open multiple terminals.
- Configure executable path, check timeout and eight legacy CLI resource budgets, plus four opt-in alpha.6 tuple/input resource limits.
- Preserve file paths with spaces by passing process arguments directly, without invoking a shell.
- Decode schema-v1 Scarp JSON errors into precise Problems ranges (including Unicode columns), with legacy human-readable diagnostic fallback. Preserve UTF-8 characters split across process output chunks.
- Keep Problems for independent .srp files separate; editing a file clears only outdated diagnostics from the affected verification.
- **Optional verify on save:** debounce rapid saves, use static-only verification where supported, and quietly refresh Problems without opening a terminal or displaying popups. In v0.1.5 development, obsolete file-check subprocesses are stopped when the checked buffer changes or closes, or when the configured compiler changes; unrelated file and project checks remain separate.
- **Outline / Go to Symbol in Editor:** show top-level Scarp `funcra` and `pure funcra` functions, `bind` / `var` declarations, `pub` exports, and `import ... as ...` aliases, without executing or compiling the file.
- **Built-in signature hovers (v0.1.5 development):** Hover over true calls to the 18 numerical, text and input functions published in compiler v0.0.6-alpha.3 through alpha.6 to see typed signatures, version requirements and domain constraints. The bounded, local scanner skips quoted strings, line comments, declarations, qualified names and prefixed identifiers. No compiler, network connection or trusted workspace is required to show this reference; the actual compiler decides whether a call is valid and supported by the installed version.
- **Built-in signature help (v0.1.6 development):** In a Scarp built-in call, typing `(` or `,` displays the published typed signature and highlights the active argument (e.g. `top_p` or `text_replace`). This lightweight, bounded parser tracks nested calls, vectors, tuples, conditionals, comments and quoted strings without compiling code. It also works in Restricted Mode. It does **not** provide semantic type checking, user-function completion or a language server; the installed Scarp compiler remains authoritative.
- **Built-in IntelliSense suggestions (v0.1.6 development):** Type at least two letters of a published built-in (such as `text_re` or `top_p_`) and use VS Code completion, including `Ctrl+Space`, to see matching function names, typed signatures, constraints and minimum compiler versions. The feature uses only the local 18-function reference catalog, does not execute source and remains available in Restricted Mode. It does not guess user functions, compile code, inject parameter lists or promise availability on older installed compilers.
- **Go to Definition / Find All References (compiler v0.0.6-alpha.1+):** invoke the official Scarp static source index on demand, resolving local and imported declarations (including named arguments). No background compiler process, caching across edits, runtime execution or invented definitions for builtins. Requires saved sources in a trusted workspace; older compilers retain editor-only Outline.
- **Browse Project Symbols (compiler alpha.1 of v0.0.6+):** select a trusted Scarp project root and search compiler-verified declarations across imported modules using a Quick Pick. The extension validates schema-v1 symbol IDs, canonical source paths and coordinates, and refuses to open outdated results when files change while the picker is open. No runtime statements or background indexing.
- **Browse Project Modules (compiler alpha.5+):** open an explicitly selected project's statically inspected module list in a Quick Pick, with entrypoint, import counts and public-symbol counts; select a module to open its source. No source is executed or changed. Malformed/out-of-root results, unsaved project buffers and external edits during inspection or selection are rejected. The browser checks saved source snapshots before and after compiler inspection and immediately before opening a module. Malformed module graphs with imports pointing to missing module IDs are rejected.
- **Scarp projects (compiler alpha.4+):** `Scarp: Create Project` creates a fresh `Scarp.project` and `src/main.srp` using the official compiler. `Scarp: Verify Project` checks the chosen project statically, and `Scarp: Launch Project` runs its declared entrypoint in an integrated terminal. In v0.1.5 development, a project verification stops its compiler subprocess when a Scarp source or manifest is edited or the compiler executable changes, without stopping unrelated checks or Run terminals. Project Launch also rejects unsaved source buffers, cancels obsolete compiler probes if project files change before terminal startup, and checks bounded disk source snapshots to catch external edits.

- **Initialize a modern project (compiler alpha.8+ development):** **Scarp: Initialize Modern Project** creates a new directory using the official compiler's `scarp init`, producing the declarative `scarp.project` manifest and starter application. The command probes `scarp guide init` and refuses unsupported compilers, preexisting destinations and untrusted/nonlocal workspaces. **Scarp: Create Project** remains available for the legacy `Scarp.project` format. Neither command installs dependencies, runs source or publishes an extension.

- **Run Project Tests (compiler v0.0.6-alpha.8+ development):** choose **Scarp: Run Project Tests** in a trusted workspace with an explicit `scarp.project` or legacy `Scarp.project` root. The extension checks the actual compiler's `guide test` support before opening a terminal, rejects unsaved project sources and sibling `tests/*.stdin` fixtures, and fingerprints test source/fixture inputs during startup so obsolete launches are cancelled. This is a user-initiated execution of ordinary Scarp test programs and does not run automatically on save. The terminal displays the compiler's own PASS/FAIL report. No test outcome is fabricated by the extension. Older compilers receive an explanatory error. Test fixture edits after terminal launch are not monitored by the extension.

- **Read-only test discovery (compiler alpha.8+ development):** **Scarp: List Project Tests** asks the official compiler for `scarp test --json --list` in a trusted, explicitly selected project. It does not compile, run, or evaluate any test source. The bounded schema-v1 decoder rejects traversal, nested paths, duplicate names and unexpected test statuses. Select a validated test file to open it without launching the program; stale disk snapshots, symlinks, unsaved project files and older compilers are rejected. A zero-test project displays an informational message, not a fabricated success.

**Alpha.7 editor compatibility:** The `sconditional` snippet expands to the new typed interpreter-only `if`/`else` value expression. The grammar also highlights lexical `\u{HEX}` Unicode scalar escape sequences inside Scarp strings; the official compiler, not the editor, validates scalar values. The pre-release extension is tested against the immutable v0.0.6-alpha.7 compiler source alongside earlier compiler compatibility gates.

**Syntax highlighting:** The grammar is editor-only, does not execute code and follows official Scarp token spelling. It highlights the published v0.0.6-alpha.3 `topk`, `topk_values`, `softmax_temp` and `logsoftmax_temp` calls, plus v0.0.6-alpha.4 `sample_area`, `sample_slopes`, `sample_cumulative_area` and `cosine_similarity`, and v0.0.6-alpha.5 `top_p`, `top_p_values` and `pearson_correlation`, only in call positions. The published alpha.6 compiler also adds the six scalar/text conversion helpers and `read_line` plus contextual `tuple<...>` syntax. Strings, comments, longer names and user declarations are excluded by tokenizer tests. Older installed compiler versions may not implement every highlighted call; the extension invokes the separately installed compiler.

**Compiler-backed definition/reference navigation** uses the v0.0.6-alpha.1 static `inspect references --json` schema. Right-click on a Scarp symbol and select Go to Definition or Find All References, or use VS Code's normal navigation shortcuts. Only saved, trusted local projects are inspected. If an explicit workspace root contains `Scarp.project`, the full project graph is examined; otherwise the active .srp file is the root. Compiler semantic errors and older compilers can return no navigation results. Results belong to a single compiler snapshot. Bounded local source hashes are checked both before and after compiler inspection and again before returning locations; if any project source changes in that interval, outdated results are discarded. In v0.1.5 development, canceled navigation requests, edits to Scarp files within the inspected root, and compiler-path switches promptly terminate obsolete CLI inspections. Unrelated source roots remain independent. Navigation remains on-demand, and later edits require reissuing the command. Files are never executed.

**Browse Project Symbols** is available in the Command Palette for a Scarp project folder containing `Scarp.project`. The compiler's static `inspect symbols --json` view includes lexical declarations from the valid project graph; builtins without source definitions are excluded. Save project files before browsing. Select a declaration to jump to its actual source; invalid or changing source metadata is rejected.

**Restricted Mode:** When a folder is untrusted, Scarp offers syntax highlighting, local read-only Outline and static built-in signature hovers only. The Run, Verify, compiler version, compiler-backed navigation and project commands require Workspace Trust; their command-palette/editor menu entries are hidden until trust is granted, and direct command invocation is rejected. The configured compiler is not launched by verification-on-save in Restricted Mode. A separate real VS Code Extension Host test validates this behavior.

**Built-in hover reference** is lexical rather than semantic and covers the 18 versioned numerical, text and input functions; it does not verify types, execute Scarp, inspect imports, index declarations or guarantee support in an older separately installed compiler. It does not attempt to provide hover help on very long lines (over 16,384 UTF-16 code units), or across more than one line between the name and the opening parenthesis.

**Outline navigation** is intentionally limited to file-scope declarations. It uses a tolerant editor scanner; definitive syntax and semantics remain the official compiler's responsibility. Local variables are not shown in the Outline. No compiler installation or workspace trust is needed to navigate a document.

**Not yet supported:** native executable compilation, project builds that emit executables, package registries or dependency management. Scarp compiler v0.0.5-alpha.4 supports interpreter-backed project creation, static verification and launching only. No fictional implementation is provided.

The latest **published** experimental pre-release is [v0.1.5](https://github.com/scarp-lang/scarp-vscode/releases/tag/v0.1.5). On 2026-11-12 the guarded publishing workflow passed, with the verified VSIX attached to GitHub Releases and both Visual Studio Marketplace and Open VSX publishing steps reporting success. [Read the v0.1.5 release notes](docs/releases/v0.1.5-public.md).

**Next planned experimental version:** v0.1.6 is in development, beginning with native static signature help for the 18 published Scarp built-ins and a new numeric VSIX package version. CI retains separate published compiler alpha.1–alpha.7 regression suites and real trusted/Restricted Mode editor tests. No v0.1.6 GitHub release or registry publication has been approved or initiated.

## Install and run

1. Install Scarp from [official compiler releases](https://github.com/scarp-lang/scarp/releases).
2. Run **scarp --version** in the workspace environment, or set **scarp.compilerPath** to the executable file (Windows example: C:\tools\scarp\scarp.exe).
3. Install a verified pre-release VSIX when available, or open the repository in a VS Code Extension Development Host.
4. Open a .srp file in a trusted workspace, then use Run or Verify in the Command Palette.

~~~scarp
print("Hello from Scarp!");
~~~

The extension uses the workspace extension host. On Remote SSH, WSL or containers, install the compiler in that environment.

## Settings

| Setting | Purpose |
| --- | --- |
| scarp.compilerPath | Full path to executable, or scarp on PATH |
| scarp.checkTimeoutMs | Timeout for checking (default: 30000 milliseconds) |
| scarp.verifyOnSave | Opt in to non-executing verification after saving a `.srp` file; **off by default** |
| scarp.showFileActionsCodeLens | Opt in to file-scoped Run/Verify inline actions in trusted `.srp` editors; **off by default** |
| scarp.maxSteps, scarp.maxPrints | Optional execution limits |
| scarp.maxCallDepth, scarp.maxCalls | Optional call limits |
| scarp.maxLiveSlots, scarp.maxCaptureBytes, scarp.maxVectorBytes, scarp.maxTextBytes | Optional memory/resource limits |
| scarp.maxTupleBytes | Optional cumulative tuple payload limit (compiler alpha.6+) |
| scarp.maxInputLineBytes, scarp.maxInputBytes, scarp.maxInputReads | Optional redirected input limits (compiler alpha.6+) |

**Project commands:** Open the project folder containing `scarp.project` or `Scarp.project` in VS Code, then choose **Scarp: Verify Project** or **Scarp: Launch Project** from the Command Palette. In multi-root workspaces, select the explicit project folder. The extension does not search parent directories for a manifest. **Scarp: Create Project** asks for the parent workspace folder and a new directory name; the compiler refuses to overwrite any existing path. Project commands are available only when `scarp diagnose --json` reports `project_workflow: true` (official v0.0.5-alpha.4+). A missing compiler or an older release produces an explanatory error, not a simulated result.

These commands run the real interpreter and static compiler, **not** native executable generation. `verify` never uses run budgets or executes normal runtime statements; `launch` uses the configured run budgets. Project diagnostics with source locations are added to Problems. Manifest errors without source locations remain visible in the Scarp Output channel.

With a Scarp v0.0.6-alpha.8 candidate compiler, existing project commands also accept the declarative manifest created by `scarp init`. The extension highlights `assert` as a language statement. The selected compiler determines which syntax and project format it supports.

**Browse project modules (v0.1.4):** With Scarp v0.0.5-alpha.5 or later installed, open a trusted project folder containing `Scarp.project` and choose **Scarp: Browse Project Modules**. Pick a module to open it. The extension calls `scarp inspect modules --json` on the explicit directory, never runs Scarp program statements, does not perform implicit project discovery, and refuses to browse unsaved project source. Inspection errors go to the Scarp Output channel. The browser validates schema version, source paths, file types and project-root containment. Module metadata reflects the files on disk when inspected, not unsaved changes or an always-updating language server.

**Project verification safety (v0.1.4):** Save open `.srp` files and `Scarp.project` before verifying. A project verification is skipped if there is already one running for the same root. If an open project file or manifest changes while the compiler is checking, its outdated result is discarded instead of updating Problems; verify again after saving. Once a project check finishes, editing any local `.srp` file or `Scarp.project` in its root clears that project's previous Problems—even if the edited file had no errors—without erasing independent checks. In v0.1.4, a bounded SHA-256 source snapshot also detects external edits, additions and deletions of local `.srp` files and the root manifest **during verification**; changed snapshots discard outdated results. The scan is limited to 20,000 directory entries, 4,096 source files, 32 directory levels and 64 MiB of input bytes. It fails closed for symlinked directories and source symlinks escaping the selected root. After a completed project verification, scoped VS Code file watchers, with a native recursive filesystem notification fallback when supported, listen for local `.srp` source and root `Scarp.project` creates/changes/deletions. When an event arrives, the extension removes outdated project-owned Problems without automatically re-running code or verification. At most eight explicit verified roots retain watchers; evicting an older root also removes its Problems rather than retaining stale diagnostics. Watching stops on invalidation, replacement or extension disposal. File watchers are best-effort and subject to VS Code filesystem watcher exclusions and operating system limitations; they do not monitor sources outside the project, guarantee detection of every external change, or detect a change reverted between verification snapshots.

**Reconcile verified diagnostics:** When VS Code regains focus, Scarp compares saved, bounded SHA-256 source snapshots for up to eight explicitly verified project roots. If external changes were missed by filesystem watchers, only that project's old Problems are cleared; no compiler or program is launched. Use **Scarp: Check Verified Project Diagnostic Freshness** in the Command Palette to run the same check manually. Re-run **Scarp: Verify Project** to refresh diagnostics. This checks only tracked roots and does not automatically monitor or scan every workspace. Unexpected read errors fail closed by clearing the affected project's stale diagnostics.

Unspecified limits use compiler defaults.

## Limitations

- The Scarp language is still alpha and can change. Compatibility must be verified against the real compiler.
- Scarp alpha.6 `read_line()` consumes explicitly redirected/piped UTF-8 input. **A connected integrated terminal does not currently support interactive Scarp input** and reports E0054 for a selected read. This extension does not emulate an input prompt; use a compatible redirected CLI invocation for input programs. Unselected reads do not fail.
- With older compilers, the legacy `check` command can evaluate reachable code; the newer `verify` command does not.
- Diagnostics use schema-v1 JSON errors with newer compilers, or human-readable errors with older compilers. Unlocated errors are shown in the Scarp Output channel.
- Only one terminal session per file; terminal output is not duplicated into Problems.
- With older Scarp compilers, `Scarp: Verify Current File` falls back to the legacy `check` command, which may evaluate program statements. For non-executing verification, install Scarp v0.0.5-alpha.3 or a newer compiler exposing `verify --help`.
- Runtime budget settings apply to execution and the legacy evaluating `check`; they do not apply to static `verify`.
- **Verify on save safety:** disabled by default; only works in trusted workspaces, with saved local `.srp` files, and on compilers supporting non-executing `verify` (v0.0.5-alpha.3+). Older compilers are skipped, never silently executed.
- Save events are coalesced for 300 ms per file and serialized. Errors update Problems and the Scarp Output channel without intrusive notifications; manual **Verify Current File** retains its existing behavior.
- Unsaved document changes are saved first when invoking manual commands.
- Native build, native compilation, code completion, AI coding, and debugging are out of scope. Compiler-backed Go to Definition and Find All References are available on v0.0.6-alpha.1+.

## Contributing and testing

Use Node.js 22+, npm and VS Code 1.96+.

~~~sh
npm install
npm run check
npm run package:pre
npm run test:integration
~~~

Syntax rules are covered by `test/syntax.test.ts` using the real TextMate/Oniguruma tokenizer, and the VSIX packaging gate asserts that `syntaxes/scarp.tmLanguage.json` is shipped.

For release policy and testing see [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/RELEASING.md](docs/RELEASING.md).

## Troubleshooting

**Compiler missing:** verify it is installed in the same workspace host as VS Code. Set scarp.compilerPath if it is not on PATH.

**Invalid version:** verify the setting points to an official Scarp executable, not a shell command or another program.

**Check failed without Problems:** use **Scarp: Show Compiler Output** to see the full stderr.

**Paths containing spaces:** do not add wrapping quotes inside scarp.compilerPath.

## Support development

This extension and the Scarp tooling are open source. You can [support their development on GitHub Sponsors](https://github.com/sponsors/sanskarIN) (monthly or one-time). Sponsorship does not unlock editor features or affect the extension's availability.

## License

MIT (extension). The separate Scarp compiler is Apache-2.0 licensed.

## Marketplace and Open VSX pre-releases

The official publisher and extension identifier are `ScarpLang.scarp` on both Visual Studio Marketplace and Open VSX. Only verified **pre-release** builds are permitted until Scarp's compiler publishes its first stable release.

The [publishing workflow](.github/workflows/prerelease.yml) supports both registries. Publishing a reviewed **GitHub pre-release** automatically publishes the same verified VSIX to both registries; normal commits and stable releases never trigger registry publishing. Maintainers can also run the workflow manually from `main`: by default it **only qualifies and saves a temporary VSIX artifact in the Actions run, without publishing a GitHub release or registry version**. Public release creation requires checking `publish_github`; either registry option additionally requires that GitHub release approval.

Marketplace authentication uses its GitHub OIDC Trusted Publisher policy for `scarp-lang/scarp-vscode` and workflow `prerelease.yml` (no Marketplace PAT). Open VSX has a verified `ScarpLang` namespace and the published `v0.1.1` pre-release. The current workflow still uses a scoped publishing token in the `OVSX_PAT` Actions secret. Tokenless Open VSX Trusted Publishing is eligible, but requires namespace-owner registration and a reviewed workflow migration before the secret can be removed. See the [release instructions](docs/RELEASING.md) for setup, exact version/tag requirements, and release guards.

The Extension Host integration tests run an actual copy of VS Code and need the `SCARP_TEST_BINARY` environment variable set to the absolute path of a compatible official Scarp executable. In Linux CI, this is built from the pinned compiler tag and launched under `xvfb-run`. These development tests do not publish a new extension version.
