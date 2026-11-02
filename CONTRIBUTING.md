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
