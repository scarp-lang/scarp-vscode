# Scarp Compiler & Runner

Official Visual Studio Code extension for the [Scarp language](https://github.com/scarp-lang/scarp). This is **experimental pre-release software** that calls the actual Scarp compiler; it does not reimplement the language.

> Never publish a stable extension until the Scarp programming language/compiler publishes its first verified stable release.

## Implemented

- Recognize .srp files as Scarp, with a real TextMate grammar for the current Scarp compiler's declarations, functions, types, control flow, strings, numeric literals, operators, and line comments.
- **Scarp: Run Current File:** launch the official compiler in the integrated terminal with program input/output. Prefer canonical `scarp exec` when the installed compiler advertises `scarp guide exec`, and retain legacy `scarp run` for older compiler versions.
- **Scarp: Verify Current File:** use the compiler's non-executing `verify` command when supported (Scarp v0.0.5-alpha.3+), including source-span JSON diagnostics in Problems. Older compilers fall back to the legacy evaluating `check` command.
- **Scarp: Show Compiler Version:** verify the executable.
- **Scarp: Stop Running Program:** stop extension-owned terminal sessions.
- Configure executable path, check timeout and eight documented CLI resource budgets.
- Preserve file paths with spaces by passing process arguments directly, without invoking a shell.
- Decode schema-v1 Scarp JSON errors into precise Problems ranges (including Unicode columns), with legacy human-readable diagnostic fallback. Preserve UTF-8 characters split across process output chunks.
- Keep Problems for independent .srp files separate; editing a file clears only outdated diagnostics from the affected verification.
- **Optional verify on save:** debounce rapid saves, use static-only verification where supported, and quietly refresh Problems without opening a terminal or displaying popups.
- **Outline / Go to Symbol in Editor:** show top-level Scarp `funcra` and `pure funcra` functions, `bind` / `var` declarations, `pub` exports, and `import ... as ...` aliases, without executing or compiling the file.
- **Scarp projects (compiler alpha.4+):** `Scarp: Create Project` creates a fresh `Scarp.project` and `src/main.srp` using the official compiler. `Scarp: Verify Project` checks the chosen project statically, and `Scarp: Launch Project` runs its declared entrypoint in an integrated terminal.

**Syntax highlighting:** The v0.1.2 grammar is editor-only and never executes code. It follows Scarp compiler v0.0.5-alpha.3 token spelling, not Python/Rust conventions. Color choices are supplied by your VS Code theme. Strings and comments do not mistakenly color embedded keywords.

**Outline navigation** is intentionally limited to file-scope declarations. It uses a tolerant editor scanner; definitive syntax and semantics remain the official compiler's responsibility. Local variables are not shown in the Outline. No compiler installation or workspace trust is needed to navigate a document.

**Not yet supported:** native executable compilation, project builds that emit executables, package registries or dependency management. Scarp compiler v0.0.5-alpha.4 supports interpreter-backed project creation, static verification and launching only. No fictional implementation is provided.

The latest **published** pre-release is [v0.1.3](https://github.com/scarp-lang/scarp-vscode/releases/tag/v0.1.3). The v0.1.3 publishing workflow passed for Visual Studio Marketplace and Open VSX using the same verified VSIX. [Read the v0.1.3 release notes](docs/releases/v0.1.3.md).

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
- Native build, native compilation, code completion, AI coding, and debugging are out of scope.

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
