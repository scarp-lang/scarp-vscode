# Scarp Compiler & Runner

Official Visual Studio Code extension for the [Scarp language](https://github.com/scarp-lang/scarp). This is **experimental pre-release software** that calls the actual Scarp compiler; it does not reimplement the language.

> Never publish a stable extension until the Scarp programming language/compiler publishes its first verified stable release.

## Implemented

- Recognize .srp files as Scarp.
- **Scarp: Run Current File:** launch the official compiler in the integrated terminal with program input/output.
- **Scarp: Verify Current File:** use the compiler's non-executing `verify` command when supported (Scarp v0.0.5-alpha.3+), including source-span JSON diagnostics in Problems. Older compilers fall back to the legacy evaluating `check` command.
- **Scarp: Show Compiler Version:** verify the executable.
- **Scarp: Stop Running Program:** stop extension-owned terminal sessions.
- Configure executable path, check timeout and seven documented CLI resource budgets.
- Preserve file paths with spaces by passing process arguments directly, without invoking a shell.
- Decode schema-v1 Scarp JSON errors into precise Problems ranges (including Unicode columns), with legacy human-readable diagnostic fallback.

**Not yet supported:** native file compilation and project builds. As of Scarp compiler v0.0.5-alpha.3 there is no compile or build command. No fictional implementation is provided.

## Install and run

1. Install Scarp from [official compiler releases](https://github.com/scarp-lang/scarp/releases).
2. Run **scarp --version** in the workspace environment, or set **scarp.compilerPath** to the executable file (Windows example: C:\tools\scarp\scarp.exe).
3. Install a verified pre-release VSIX when available, or open the repository in a VS Code Extension Development Host.
4. Open a .srp file in a trusted workspace, then use Run or Check in the Command Palette.

~~~scarp
print("Hello from Scarp!");
~~~

The extension uses the workspace extension host. On Remote SSH, WSL or containers, install the compiler in that environment.

## Settings

| Setting | Purpose |
| --- | --- |
| scarp.compilerPath | Full path to executable, or scarp on PATH |
| scarp.checkTimeoutMs | Timeout for checking (default: 30000 milliseconds) |
| scarp.maxSteps, scarp.maxPrints | Optional execution limits |
| scarp.maxCallDepth, scarp.maxCalls | Optional call limits |
| scarp.maxLiveSlots, scarp.maxCaptureBytes, scarp.maxVectorBytes | Optional memory/resource limits |

Unspecified limits use compiler defaults.

## Limitations

- The Scarp language is still alpha and can change. Compatibility must be verified against the real compiler.
- Check can evaluate reachable code; it is not a static-only check.
- Diagnostics use Scarp's current human-readable error location format. Other error text is shown in the Scarp Output channel.
- Only one terminal session per file; terminal output is not duplicated into Problems.\n- With older Scarp compilers, `Scarp: Verify Current File` falls back to the legacy `check` command, which may evaluate program statements. For non-executing verification, install Scarp v0.0.5-alpha.3 or a newer compiler exposing `verify --help`.
- Runtime budget settings apply to execution and the legacy evaluating `check`; they do not apply to static `verify`.
- Unsaved document changes are saved first.
- Native build, native compilation, code completion, AI coding, and debugging are out of scope.

## Contributing and testing

Use Node.js 22+, npm and VS Code 1.96+.

~~~sh
npm install
npm run check
npm run package:pre
npm run test:integration
~~~

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

Marketplace authentication uses its GitHub OIDC Trusted Publisher policy for `scarp-lang/scarp-vscode` and workflow `prerelease.yml` (no Marketplace PAT). Open VSX initially uses a scoped publishing token in the `OVSX_PAT` GitHub Actions secret; it can switch to Trusted Publishing once the first version is active. See the [release instructions](docs/RELEASING.md) for setup, exact version/tag requirements, and release guards.

The Extension Host integration tests run an actual copy of VS Code and need the `SCARP_TEST_BINARY` environment variable set to the absolute path of a compatible official Scarp executable. In Linux CI, this is built from the pinned compiler tag and launched under `xvfb-run`. These development tests do not publish a new extension version.
