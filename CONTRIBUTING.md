# Contributing

Please keep this extension tightly scoped to verified compiler integration and program execution.

Install Node.js 22+, npm and VS Code; clone the repository, run **npm install** and **npm run check**, then test in the VS Code Extension Development Host.

For the requested local Git author identity, run:

~~~sh
git config user.name "Sanskar"
git config user.email "sanskarin@outlook.in"
~~~

This configures your local clone, not commits produced through the GitHub API connection.

Use meaningful feature branches and pull requests. Include tests for bugs, run type checking, ESLint, tests and experimental VSIX packaging. For compiler compatibility reports, provide the real compiler version, platform and sanitized failure output.

Do not publish a stable release until the Scarp compiler itself has published its first official stable release. Interim Marketplace builds must be **pre-release**.

See [release policy](docs/RELEASING.md).

## Integration testing in VS Code

The regular `npm run check` command runs TypeScript checks, linting, and unit tests. The additional `npm run test:integration` command launches a real VS Code Extension Host and requires a **compatible official Scarp compiler**:

~~~sh
# Replace the path with the location of your tested Scarp executable.
SCARP_TEST_BINARY=/absolute/path/to/scarp npm run test:integration
~~~

On Windows PowerShell, set `$env:SCARP_TEST_BINARY` to the full compiler executable path before running the command. On Linux CI, tests run through `xvfb-run` and use Scarp v0.0.5-alpha.2 built from its official tag.

The integration suite checks language association, command registration, diagnostics, and Run/Stop behavior. It does not yet cover every import graph or every platform's GUI environment. CI packaging is not a public release.
