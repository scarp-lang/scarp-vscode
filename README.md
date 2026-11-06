# Scarp Compiler & Runner

Official Visual Studio Code extension for the [Scarp language](https://github.com/scarp-lang/scarp). This is **experimental pre-release software** that calls the actual Scarp compiler; it does not reimplement the language.

> Never publish a stable extension until the Scarp programming language/compiler publishes its first verified stable release.

## Implemented

- Recognize .srp files as Scarp, with a real TextMate grammar for the current Scarp compiler's declarations, functions, types, control flow, strings, numeric literals, operators, and line comments.
- **Scarp: Run Current File:** launch the official compiler in the integrated terminal with program input/output. Prefer canonical `scarp exec` when the installed compiler advertises `scarp guide exec`, and retain legacy `scarp run` for older compiler versions.
- **Scarp: Verify Current File:** use the compiler's non-executing `verify` command when supported (Scarp v0.0.5-alpha.3+), including source-span JSON diagnostics in Problems. Older compilers fall back to the legacy evaluating `check` command.
- **Scarp: Show Compiler Version:** verify the executable.
- **Scarp: Stop Running Program:** stop extension-owned terminal sessions and cancel file/project starts that are still waiting for compiler detection. Duplicate Run or Launch commands for the same source/project cannot open multiple terminals.
- Configure executable path, check timeout and eight documented CLI resource budgets.
- Preserve file paths with spaces by passing process arguments directly, without invoking a shell.
- Decode schema-v1 Scarp JSON errors into precise Problems ranges (including Unicode columns), with legacy human-readable diagnostic fallback. Preserve UTF-8 characters split across process output chunks.
- Keep Problems for independent .srp files separate; editing a file clears only outdated diagnostics from the affected verification.
- **Optional verify on save:** debounce rapid saves, use static-only verification where supported, and quietly refresh Problems without opening a terminal or displaying popups. In v0.1.5 development, obsolete file-check subprocesses are stopped when the checked buffer changes or closes, or when the configured compiler changes; unrelated file and project checks remain separate.
- **Outline / Go to Symbol in Editor:** show top-level Scarp `funcra` and `pure funcra` functions, `bind` / `var` declarations, `pub` exports, and `import ... as ...` aliases, without executing or compiling the file.
- **Go to Definition / Find All References (compiler v0.0.6-alpha.1+):** invoke the official Scarp static source index on demand, resolving local and imported declarations (including named arguments). No background compiler process, caching across edits, runtime execution or invented definitions for builtins. Requires saved sources in a trusted workspace; older compilers retain editor-only Outline.
- **Browse Project Symbols (compiler alpha.1 of v0.0.6+):** select a trusted Scarp project root and search compiler-verified declarations across imported modules using a Quick Pick. The extension validates schema-v1 symbol IDs, canonical source paths and coordinates, and refuses to open outdated results when files change while the picker is open. No runtime statements or background indexing.
- **Browse Project Modules (compiler alpha.5+):** open an explicitly selected project's statically inspected module list in a Quick Pick, with entrypoint, import counts and public-symbol counts; select a module to open its source. No source is executed or changed. Malformed/out-of-root results, unsaved project buffers and external edits during inspection or selection are rejected. The browser checks saved source snapshots before and after compiler inspection and immediately before opening a module.
- **Scarp projects (compiler alpha.4+):** `Scarp: Create Project` creates a fresh `Scarp.project` and `src/main.srp` using the official compiler. `Scarp: Verify Project` checks the chosen project statically, and `Scarp: Launch Project` runs its declared entrypoint in an integrated terminal.

**Syntax highlighting:** The v0.1.2 grammar is editor-only and never executes code. It follows Scarp compiler v0.0.5-alpha.3 token spelling, not Python/Rust conventions. Color choices are supplied by your VS Code theme. Strings and comments do not mistakenly color embedded keywords.

**Compiler-backed definition/reference navigation** uses the v0.0.6-alpha.1 static `inspect references --json` schema. Right-click on a Scarp symbol and select Go to Definition or Find All References, or use VS Code's normal navigation shortcuts. Only saved, trusted local projects are inspected. If an explicit workspace root contains `Scarp.project`, the full project graph is examined; otherwise the active .srp file is the root. Compiler semantic errors and older compilers can return no navigation results. Results belong to a single compiler snapshot. Bounded local source hashes are checked both before and after compiler inspection and again before returning locations; if any project source changes in that interval, outdated results are discarded. In v0.1.5 development, canceled navigation requests promptly terminate the corresponding CLI inspection, and switching `scarp.compilerPath` rejects results from the previous executable. Navigation remains on-demand, and later edits require reissuing the command. Files are never executed.

**Browse Project Symbols** is available in the Command Palette for a Scarp project folder containing `Scarp.project`. The compiler's static `inspect symbols --json` view includes lexical declarations from the valid project graph; builtins without source definitions are excluded. Save project files before browsing. Select a declaration to jump to its actual source; invalid or changing source metadata is rejected.

**Restricted Mode:** When a folder is untrusted, Scarp offers syntax highlighting and local read-only Outline only. The Run, Verify, compiler version, compiler-backed navigation and project commands require Workspace Trust; their command-palette/editor menu entries are hidden until trust is granted, and direct command invocation is rejected. The configured compiler is not launched by verification-on-save in Restricted Mode. A separate real VS Code Extension Host test validates this behavior.

**Outline navigation** is intentionally limited to file-scope declarations. It uses a tolerant editor scanner; definitive syntax and semantics remain the official compiler's responsibility. Local variables are not shown in the Outline. No compiler installation or workspace trust is needed to navigate a document.

**Not yet supported:** native executable compilation, project builds that emit executables, package registries or dependency management. Scarp compiler v0.0.5-alpha.4 supports interpreter-backed project creation, static verification and launching only. No fictional implementation is provided.

The latest **published** experimental pre-release is [v0.1.4](https://github.com/scarp-lang/scarp-vscode/releases/tag/v0.1.4). On 2026-11-06 the approved publishing workflow successfully uploaded the verified VSIX to GitHub Releases, Visual Studio Marketplace and Open VSX. [Read the v0.1.4 release notes](docs/releases/v0.1.4.md).

**Next planned experimental version:** v0.1.5 is in development. Release asset comparisons now validate literal ZIP entries including `[Content_Types].xml`, and Go to Definition / Find References requests gain cancellable compiler inspections. The released extension supports Scarp compiler **v0.0.6-alpha.1** static project/module inspection, symbol navigation and source verification; it is not a graphical dependency editor or full language server.

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
| scarp.maxSteps, scarp.maxPrints | Optional execution limits |
| scarp.maxCallDepth, scarp.maxCalls | Optional call limits |
| scarp.maxLiveSlots, scarp.maxCaptureBytes, scarp.maxVectorBytes, scarp.maxTextBytes | Optional memory/resource limits |

**Project commands:** Open the project folder containing `Scarp.project` in VS Code, then choose **Scarp: Verify Project** or **Scarp: Launch Project** from the Command Palette. In multi-root workspaces, select the explicit project folder. The extension does not search parent directories for a manifest. **Scarp: Create Project** asks for the parent workspace folder and a new directory name; the compiler refuses to overwrite any existing path. Project commands are available only when `scarp diagnose --json` reports `project_workflow: true` (official v0.0.5-alpha.4+). A missing compiler or an older release produces an explanatory error, not a simulated result.

These commands run the real interpreter and static compiler, **not** native executable generation. `verify` never uses run budgets or executes normal runtime statements; `launch` uses the configured run budgets. Project diagnostics with source locations are added to Problems. Manifest errors without source locations remain visible in the Scarp Output channel.

**Browse project modules (v0.1.4):** With Scarp v0.0.5-alpha.5 or later installed, open a trusted project folder containing `Scarp.project` and choose **Scarp: Browse Project Modules**. Pick a module to open it. The extension calls `scarp inspect modules --json` on the explicit directory, never runs Scarp program statements, does not perform implicit project discovery, and refuses to browse unsaved project source. Inspection errors go to the Scarp Output channel. The browser validates schema version, source paths, file types and project-root containment. Module metadata reflects the files on disk when inspected, not unsaved changes or an always-updating language server.

**Project verification safety (v0.1.4):** Save open `.srp` files and `Scarp.project` before verifying. A project verification is skipped if there is already one running for the same root. If an open project file or manifest changes while the compiler is checking, its outdated result is discarded instead of updating Problems; verify again after saving. Once a project check finishes, editing any local `.srp` file or `Scarp.project` in its root clears that project's previous Problems—even if the edited file had no errors—without erasing independent checks. In v0.1.4, a bounded SHA-256 source snapshot also detects external edits, additions and deletions of local `.srp` files and the root manifest **during verification**; changed snapshots discard outdated results. The scan is limited to 20,000 directory entries, 4,096 source files, 32 directory levels and 64 MiB of input bytes. It fails closed for symlinked directories and source symlinks escaping the selected root. After a completed project verification, scoped VS Code file watchers, with a native recursive filesystem notification fallback when supported, listen for local `.srp` source and root `Scarp.project` creates/changes/deletions. When an event arrives, the extension removes outdated project-owned Problems without automatically re-running code or verification. At most eight explicit verified roots retain watchers; evicting an older root also removes its Problems rather than retaining stale diagnostics. Watching stops on invalidation, replacement or extension disposal. File watchers are best-effort and subject to VS Code filesystem watcher exclusions and operating system limitations; they do not monitor sources outside the project, guarantee detection of every external change, or detect a change reverted between verification snapshots.

**Reconcile verified diagnostics:** When VS Code regains focus, Scarp compares saved, bounded SHA-256 source snapshots for up to eight explicitly verified project roots. If external changes were missed by filesystem watchers, only that project's old Problems are cleared; no compiler or program is launched. Use **Scarp: Check Verified Project Diagnostic Freshness** in the Command Palette to run the same check manually. Re-run **Scarp: Verify Project** to refresh diagnostics. This checks only tracked roots and does not automatically monitor or scan every workspace. Unexpected read errors fail closed by clearing the affected project's stale diagnostics.

Unspecified limits use compiler defaults.

## Limitations

- The Scarp language is still alpha and can change. Compatibility must be verified against the real compiler.
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

## License

MIT (extension). The separate Scarp compiler is Apache-2.0 licensed.

## Marketplace and Open VSX pre-releases

The official publisher and extension identifier are `ScarpLang.scarp` on both Visual Studio Marketplace and Open VSX. Only verified **pre-release** builds are permitted until Scarp's compiler publishes its first stable release.

The [publishing workflow](.github/workflows/prerelease.yml) supports both registries. Publishing a reviewed **GitHub pre-release** automatically publishes the same verified VSIX to both registries; normal commits and stable releases never trigger registry publishing. Alternatively, maintainers can manually run the workflow from `main` and explicitly select either or both publishing targets.

Marketplace authentication uses its GitHub OIDC Trusted Publisher policy for `scarp-lang/scarp-vscode` and workflow `prerelease.yml` (no Marketplace PAT). Open VSX has a verified `ScarpLang` namespace and the published `v0.1.1` pre-release. The current workflow still uses a scoped publishing token in the `OVSX_PAT` Actions secret. Tokenless Open VSX Trusted Publishing is eligible, but requires namespace-owner registration and a reviewed workflow migration before the secret can be removed. See the [release instructions](docs/RELEASING.md) for setup, exact version/tag requirements, and release guards.

The Extension Host integration tests run an actual copy of VS Code and need the `SCARP_TEST_BINARY` environment variable set to the absolute path of a compatible official Scarp executable. In Linux CI, this is built from the pinned compiler tag and launched under `xvfb-run`. These development tests do not publish a new extension version.
