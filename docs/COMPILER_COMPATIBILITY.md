# Scarp compiler compatibility and execution boundaries

This document tracks the **published** Scarp compiler contracts used by the VS Code extension. It is not a stable-language specification. The compiler defines semantics and error messages; the extension supplies editor conveniences and explicitly invokes the installed `scarp` executable when requested.

## Published compiler baseline

| Scarp compiler | Supported extension behavior |
| --- | --- |
| v0.0.6-alpha.6+ | Typed tuples, redirected UTF-8 input, text conversion and optional input/tuple limits |
| v0.0.6-alpha.7+ | Conditional values and Unicode scalar string escapes |
| v0.0.6-alpha.8+ | Manifest-backed projects, `scarp init`, `scarp test`, assertions, test discovery and explicit project commands |
| v0.0.6-alpha.9+ | Exact BigInt helpers, versioned structured test reports and optional BigInt budgets |
| v0.0.6-alpha.10+ | Explicit `--interactive` prompts, EOF-aware input, fixed arrays, `--input-file` and shared `--max-array-bytes` flag |
| v0.0.6-alpha.11+ | Exact decimal values, explicit rounding and typed interactive decimal input |
| v0.0.6-alpha.12+ | Immutable typed lists/maps, records, variants, Option/Result, checked `match` and `?` propagation in immutable function bindings |
| v0.0.6-alpha.13+ | The same released CLI contracts, plus opt-in Rust embedding cache/editor-generation APIs **not exposed as a VS Code or CLI protocol** |
| v0.0.6-alpha.14+ | More precise syntax diagnostics for malformed nested destructuring, additional Rust host cache controls and an experimental ELF64 kernel API; **no new editor-facing CLI command or module schema** |
| v0.0.6-alpha.15+ | `inspect tokens` and `inspect ast` reject source files over 1 MiB before lexing; equal-byte-length string comparisons consume bounded interpreter/constant-evaluation steps. Rust host revision-cache and experimental ELF64 shift changes do **not** introduce a VS Code CLI protocol |
| v0.0.6-alpha.16+ | Pure median/quantile, Unicode text and checked i64 scalar utilities with local editor-only call hints |
| v0.0.6-alpha.17+ | Pure `array_len` and eagerly evaluated typed fallback `array_get_or` for fixed arrays; `input_boolean` accepts exact lowercase `true`/`false` only with explicit interactive input |
| v0.0.6-alpha.18+ | Default-entry `scarp exec` with no source argument and immutable `array_set`; editor commands probe installed CLI capabilities before execution |
| v0.0.6-alpha.19+ | New Rust-host callable embedding/usage accounting APIs only; no first-class callable Scarp source values or new VS Code CLI protocol |
| v0.0.6-alpha.20+ | Exact lowercase `d` decimal literals (`0.1d`, `42d`); constant-index assignment to mutable tuples with persistent snapshots; lexicographic comparison of compatible numeric tuples; `scarp init` / `scarp create` now scaffold lowercase `scarp.project`. Experimental Linux x86-64 pure-function object generation is a Rust embedding API, **not** an editor execution mode. |

The v0.1.6 dedicated lowercase `scarp.project` language is lexical editor assistance only. Published alpha.20 creates lowercase v2 project manifests. Alpha.19 and older binaries may scaffold uppercase manifests; uppercase `Scarp.project` remains a separately recognized legacy manifest. The editor never rewrites either format.

Exact `d` literals are visually distinct from unsuffixed IEEE-754 `float` literals. The editor does not infer numeric types, validate decimal precision or promise `d` support from older installed compilers. Tuple member replacement is an explicit source assignment, requiring a mutable `var` binding and a constant nonnegative index; no automatic code transformation is performed.

Versions above describe a minimum release for particular features; they do not imply native compilation, a GUI runtime, or semantic editor completion. Syntax highlighting, snippets, local Outline and built-in help are **compiler-free**. From the published alpha.12 pattern syntax, local Outline also lists each named binding in top-level tuple, fixed-array and record destructuring, including nested patterns; discard `_` and record field labels never appear as declarations. This is error-tolerant lexical indexing, not type checking, and malformed patterns are omitted. The installed compiler may be older than the newest built-in help entry; a version label is not a capability probe.

## Compiler installation and discovery

The extension does **not automatically** install or download a compiler. The explicitly confirmed setup wizard below can install one. With the default `scarp.compilerPath = "scarp"`, a trusted compiler action first probes the executable in PATH using `--version`. Only if the command cannot be found does optional `scarp.autoDiscoverCompiler` search a bounded list of existing, direct candidate paths (absolute PATH entries, Rust/Cargo directories, and conventional user/system installation folders). No recursive directory walking, workspace search or Downloads search is performed. Candidates must be executable files and advertise a valid `scarp --version` response. Exact compiler support still depends on the executable's actual capabilities.

An explicitly configured executable path is **never** replaced by an automatically discovered one. Discovery is cancellable and runs in the VS Code extension host (including remote SSH, containers or WSL when applicable). It does not run on extension activation, editor hover, completion or highlighting. Disabling `scarp.autoDiscoverCompiler` restores PATH-or-explicit-path-only behavior.

## Explicit official compiler setup (development-only)

Every slow setup step (local detection, manual file validation, release catalogue lookup, and the native download/install process) is now a cancellable, user-requested progress notification. Cancelling a download, extraction, or executable-version probe leaves the current compiler selection unchanged and removes temporary installer staging files. If cancellation occurs after a versioned package has already been committed, the installed directory may remain available for an explicit reuse, but is not automatically selected. The installer never overwrites a previously invalid installed compiler.

Setup rejects stale configuration: if the trusted workspace or the configured compiler path changes during a picker, verification, download, or confirmation, that invocation cannot later replace the user's updated setting. Real failures show contextual recovery actions, including Retry Setup, Choose Compiler File, View Official Releases and Open Compiler Settings, offered only when sensible; every retry and selection is initiated by a new user click. An unsupported native platform does not trigger repeated downloads, and a checksum/version validation failure does not expose a bypass option. The separate Compiler Manager's official-release update check is also cancellable without producing a misleading setup error.


Run **Scarp: Set Up Compiler** from the Command Palette in a trusted workspace. This command offers four explicit choices: detect an existing compiler, select a compiler file, open the official GitHub releases, or install a published native Scarp package. Merely opening a Scarp source, using IntelliSense, saving, verifying or running **never** downloads a compiler. The installer is deliberately separate from Run/Verify and has a modal confirmation before fetching any executable.

For an installation, the wizard queries the GitHub release API, checks that the release is publicly published rather than draft, selects the exact native package for `win32/x64`, `linux/x64`, or `darwin/arm64`, and refuses unsupported platform/architecture pairs. Asset URLs must match the exact `scarp-lang/scarp` release and version; HTTPS redirects are restricted to known GitHub asset hosts. Response size and time are capped, and cancellation aborts the transfer. Both the GitHub release API's SHA-256 digest and the published `.sha256` sidecar digest/contents must match before unpacking. A bounded archive reader extracts **only** the versioned `scarp`/`scarp.exe` member, never arbitrary archive paths. It rejects duplicate, unsafe or corrupted executable members. A temporary staging path under VS Code extension storage is cleaned after errors or cancellations; an existing invalid version directory is not overwritten. The executable must report the exact published version before its absolute path is saved as the machine-level `scarp.compilerPath` setting.

This workflow executes a newly downloaded executable with `--version` as part of the **explicit** install. Only install releases you trust; checksum verification proves agreement with the published release, not that executable programs are inherently safe. No background updates, release publication, dependency installation, or changes to Scarp source files occur. Remote SSH, WSL and containers download onto their **remote extension host**, not the local VS Code client. A manual compiler-path selection is also validated before configuration.

## On-demand Compiler Manager and release comparison (development-only)

**Scarp: Manage Compiler** is available from the Command Palette and a small status-bar action when a trusted Scarp editor is active. Merely displaying the status bar **does not** invoke the compiler or access the network. Selecting Manage explicitly runs the configured compiler's `--version` (with the existing bounded PATH fallback) and reports its resolved path, version and whether the executable came from the setting, PATH, or auto-discovery. The manager offers a read-only details view and clipboard action, local compiler settings, the setup wizard, and the official releases webpage.

**Check Official Compiler Updates** is a separate manual manager action. Only then does the extension request the latest published native package metadata via the same bounded, GitHub-host-only release reader used by installer setup. It compares numeric major/minor/patch and SemVer prerelease identifiers, so `alpha.17` is newer than `alpha.9`. A draft, unsupported host package, invalid response or unparsable version never justifies an automatic replacement. The result displays whether a newer published native package is available, already installed, or older than the selected executable. It offers **Set Up Compiler** (which retains its separate modal install confirmation) or a direct official release page. No update is downloaded or installed during the check. In remote workspaces, both version and native package selection refer to the **remote extension host**.

The manager's compatibility text is informational: the alpha.17 reference is a documented editor feature floor, **not** proof that a local CLI supports a particular built-in. Source verification, interactive execution and navigation still use the installed compiler's actual capability probes. A compiler-path change invalidates pending inspections; Restricted Mode blocks both the manager and setup commands even if invoked programmatically.

## Module metadata and native path compatibility

Compiler module inspection retains the bounded graph fields of schema versions **1–3**. Published alpha.12 adds **schema v4** for nominal records and **schema v5** when variants are present. The extension's read-only module browser accepts and validates those versions; unknown newer versions fail closed rather than being guessed.

On Windows, the Rust canonical filesystem loader may emit `\\\\?\\`-namespaced drive or UNC paths while Node and VS Code operate on conventional real paths. The module browser compares paths using a common native namespace, verifies containment within the selected canonical project root, and reconstructs ordinary root-relative filenames. Different volumes, traversal and project prefix collisions remain rejected. The module browser never grants access outside the selected project or bypasses Workspace Trust. The compiler-backed Go to Definition and Find References parsers now apply the same native canonical containment check to their schema-v1 index file labels before opening files; compiler-reported verbatim Windows paths resolve to ordinary editor paths, while different volumes, symlink escapes, and prefix collisions remain invalid. Navigation additionally requires a saved, unchanged source snapshot and explicit Workspace Trust.

## Resource limits and safe defaults

The following settings are optional and default to **not forwarding a flag**. The compiler retains its own published default:

- `scarp.maxTupleBytes` forwards `--max-tuple-bytes`: cumulative **logical** tuple allocation budget since alpha.6; records and variants consume this shared budget from alpha.12 onward.
- `scarp.maxArrayBytes` forwards `--max-array-bytes`: cumulative **logical** fixed-array budget since alpha.10; immutable typed lists and maps share that allocation budget beginning in alpha.12.
- `scarp.maxInputLineBytes`, `scarp.maxInputBytes`, and `scarp.maxInputReads` forward corresponding input quotas. Redirected input is available since alpha.6; alpha.10+ can read from a selected interactive reader when the user **explicitly** starts an interactive run. Setting quotas does not enable prompts.
- `scarp.maxBigIntDigits` / `scarp.maxBigIntBytes` forward published alpha.9 budgets only on explicit execution.
- These values account compiler-defined logical work/storage or selected input, **not physical process RSS or OS-level sandboxing**.

No resource-budget flag is sent by compiler-free editor providers. Static `verify` does not execute the source program, and project read-only discovery does not run test code. Explicit `Run`, `Launch`, `Run Interactively`, and project test commands execute the interpreter and should be used with trusted code and a trusted workspace.

## Real published native packages (CI gate)

The non-publishing `Published alpha.17/alpha.19 native package + VS Code Host` CI matrix covers **Windows x64, Linux x64 and macOS Apple Silicon**, with runner host architecture matched to the official target. It independently checks both pinned public `v0.0.6-alpha.17` and `v0.0.6-alpha.19` release metadata and package archives through the extension's own HTTPS downloader; testing the latest release does not discard historical distribution coverage. Each archive **and** checksum-sidecar digest is compared against a separately pinned SHA-256 value, as well as the GitHub release metadata. The same installer that the explicit user-driven setup wizard calls must accept the archive, extract only `scarp`/`scarp.exe` to a fresh versioned directory, validate its exact version, and leave no staging directories. Reusing a verified installation must cause no additional download.

The downloaded executable then runs `verify` without evaluating source and `exec` with expected output. A real VS Code Extension Host receives exactly that installed executable, uses it for file verification and Run, surfaces actual diagnostics for invalid Scarp, and checks that normal actions never start another compiler installation. These tests do **not** automatically install or upgrade compilers on end-user machines and never publish extension packages. The historical pinned-source compiler suite remains independent and is still mandatory.

## How compatibility is verified

`.github/workflows/ci.yml` pins immutable published Scarp commits rather than building arbitrary compiler `main`:

- Each pinned job builds an official compiler from its released tag and validates its exact Git SHA.
- Published feature fixtures run `scarp verify` first, then explicit `scarp exec` with golden stdout comparisons where appropriate.
- Starter snippets are expanded and checked using `scripts/verify-snippets.cjs` and the correct minimum published alpha. The snippet verifier **never executes** snippet source.
- Published alpha.12 and alpha.13 jobs run real list/map and structured type fixtures, plus the multi-file task-board application, using its published manifest and test suite.
- The published alpha.14 job pins approved source `43627b74af5fccccc5e233e98207413983ebafc1`, checks nested destructuring and map projection snapshots against the official stdout fixtures, rejects malformed nesting and feeds the real schema-v1 diagnostic output through the extension parser, validates the real module JSON, statically verifies editor snippets and exercises the Linux VS Code Extension Host with that compiler.
- The separate published alpha.15 job pins source `a21b7b6d942bd1ca9abbbbb522f92f9c8e21e281`, checks that token/AST inspection accepts an exactly 1 MiB UTF-8 file but rejects a 1 MiB + 1 byte file without partial stdout, and reruns real navigation schema v1, module schema v4/v5, snippets, the task-board project, golden-output examples and the Linux VS Code Extension Host. This is a non-publishing compatibility gate.
- The published alpha.17 job pins source `7831a37939965f557ce746e1d86bf82d3d629f74`, statically verifies both new snippets, checks official array and Boolean input golden-output examples and reruns the Linux VS Code Extension Host. It uses `--interactive` and an explicit input file only in a user-code execution compatibility test, not during editor hinting.
- Windows, Linux and macOS checks run extension typechecking and unit tests. The Linux VS Code Extension Host runs its full POSIX signal/termination stress suite. The **published alpha.13 and alpha.14 Windows** VS Code Extension Host jobs run a separate native, shell-free suite exercising actual record/variant Outline, map hover/completion/signatures, static Problems, compiler execution, modules schema v5 and project verification. Windows also builds both exact published compiler sources, runs golden-output and task-board tests, and tests alpha.14 nested destructuring and persistent map snapshot fixtures directly against the Windows interpreter. A Restricted Mode Linux host test verifies the trust boundary.

To verify your installed compiler locally, use `scarp --version`, then run the extension's **Scarp: Show Compiler Version** command. For project input, choose a published example and an explicit `scarp verify PATH` command. Do not assume editor completion grants execution support in an older installed compiler.

## Compatibility scope and release rules

This extension never installs or upgrades the compiler automatically; compiler installation requires the explicit, confirmed setup wizard. Workspace Trust, saved-source checks, cancellation, path containment and compiler capability probes continue to gate privileged operations. Alpha.13–alpha.15 Rust embedding/cache and experimental native-kernel APIs require a separate host integration design; the extension's current implementation uses the compiler's released CLI and its own editor-side source-generation validation.

The extension is still **experimental**. Do not publish a stable VS Code extension before Scarp publishes and verifies a stable compiler release. Pre-release publishing to Visual Studio Marketplace or Open VSX requires explicit owner authorization and the repository's existing release gates.
