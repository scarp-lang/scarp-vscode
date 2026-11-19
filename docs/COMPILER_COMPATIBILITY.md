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

Versions above describe a minimum release for particular features; they do not imply native compilation, a GUI runtime, or semantic editor completion. Syntax highlighting, snippets, local Outline and built-in help are **compiler-free**. From the published alpha.12 pattern syntax, local Outline also lists each named binding in top-level tuple, fixed-array and record destructuring, including nested patterns; discard `_` and record field labels never appear as declarations. This is error-tolerant lexical indexing, not type checking, and malformed patterns are omitted. The installed compiler may be older than the newest built-in help entry; a version label is not a capability probe.

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

## How compatibility is verified

`.github/workflows/ci.yml` pins immutable published Scarp commits rather than building arbitrary compiler `main`:

- Each pinned job builds an official compiler from its released tag and validates its exact Git SHA.
- Published feature fixtures run `scarp verify` first, then explicit `scarp exec` with golden stdout comparisons where appropriate.
- Starter snippets are expanded and checked using `scripts/verify-snippets.cjs` and the correct minimum published alpha. The snippet verifier **never executes** snippet source.
- Published alpha.12 and alpha.13 jobs run real list/map and structured type fixtures, plus the multi-file task-board application, using its published manifest and test suite.
- The published alpha.14 job pins approved source `43627b74af5fccccc5e233e98207413983ebafc1`, checks nested destructuring and map projection snapshots against the official stdout fixtures, rejects malformed nesting and feeds the real schema-v1 diagnostic output through the extension parser, validates the real module JSON, statically verifies editor snippets and exercises the Linux VS Code Extension Host with that compiler.
- The separate published alpha.15 job pins source `a21b7b6d942bd1ca9abbbbb522f92f9c8e21e281`, checks that token/AST inspection accepts an exactly 1 MiB UTF-8 file but rejects a 1 MiB + 1 byte file without partial stdout, and reruns real navigation schema v1, module schema v4/v5, snippets, the task-board project, golden-output examples and the Linux VS Code Extension Host. This is a non-publishing compatibility gate.
- Windows, Linux and macOS checks run extension typechecking and unit tests. The Linux VS Code Extension Host runs its full POSIX signal/termination stress suite. The **published alpha.13 and alpha.14 Windows** VS Code Extension Host jobs run a separate native, shell-free suite exercising actual record/variant Outline, map hover/completion/signatures, static Problems, compiler execution, modules schema v5 and project verification. Windows also builds both exact published compiler sources, runs golden-output and task-board tests, and tests alpha.14 nested destructuring and persistent map snapshot fixtures directly against the Windows interpreter. A Restricted Mode Linux host test verifies the trust boundary.

To verify your installed compiler locally, use `scarp --version`, then run the extension's **Scarp: Show Compiler Version** command. For project input, choose a published example and an explicit `scarp verify PATH` command. Do not assume editor completion grants execution support in an older installed compiler.

## Compatibility scope and release rules

This extension never installs or upgrades the compiler automatically. Workspace Trust, saved-source checks, cancellation, path containment and compiler capability probes continue to gate privileged operations. Alpha.13–alpha.15 Rust embedding/cache and experimental native-kernel APIs require a separate host integration design; the extension's current implementation uses the compiler's released CLI and its own editor-side source-generation validation.

The extension is still **experimental**. Do not publish a stable VS Code extension before Scarp publishes and verifies a stable compiler release. Pre-release publishing to Visual Studio Marketplace or Open VSX requires explicit owner authorization and the repository's existing release gates.
