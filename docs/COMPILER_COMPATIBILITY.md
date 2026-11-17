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

Versions above describe a minimum release for particular features; they do not imply native compilation, a GUI runtime, or semantic editor completion. Syntax highlighting, snippets, local Outline and built-in help are **compiler-free**. The installed compiler may be older than the newest built-in help entry; a version label is not a capability probe.

## Module metadata and native path compatibility

Compiler module inspection retains the bounded graph fields of schema versions **1–3**. Published alpha.12 adds **schema v4** for nominal records and **schema v5** when variants are present. The extension's read-only module browser accepts and validates those versions; unknown newer versions fail closed rather than being guessed.

On Windows, the Rust canonical filesystem loader may emit `\\\\?\\`-namespaced drive or UNC paths while Node and VS Code operate on conventional real paths. The module browser compares paths using a common native namespace, verifies containment within the selected canonical project root, and reconstructs ordinary root-relative filenames. Different volumes, traversal and project prefix collisions remain rejected. The module browser never grants access outside the selected project or bypasses Workspace Trust.

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
- Windows, Linux and macOS checks run extension typechecking and unit tests. Dedicated Linux and **published alpha.13 Windows** VS Code Extension Host tests exercise real editor providers; Windows also builds the exact release source and runs structured-feature and project tests. A Restricted Mode Linux host test verifies the safety boundary.

To verify your installed compiler locally, use `scarp --version`, then run the extension's **Scarp: Show Compiler Version** command. For project input, choose a published example and an explicit `scarp verify PATH` command. Do not assume editor completion grants execution support in an older installed compiler.

## Compatibility scope and release rules

This extension never installs or upgrades the compiler automatically. Workspace Trust, saved-source checks, cancellation, path containment and compiler capability probes continue to gate privileged operations. Alpha.13 Rust embedding APIs require a separate host integration design; the extension's current implementation uses the compiler's released CLI and its own editor-side source-generation validation.

The extension is still **experimental**. Do not publish a stable VS Code extension before Scarp publishes and verifies a stable compiler release. Pre-release publishing to Visual Studio Marketplace or Open VSX requires explicit owner authorization and the repository's existing release gates.
