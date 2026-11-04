#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: verify-vsix.sh <scarp-version.vsix> <major.minor.patch>" >&2
  exit 2
fi

vsix="$1"
version="$2"
test -f "$vsix"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Invalid numeric VSIX version: $version" >&2
  exit 1
}

entries="$(unzip -Z1 "$vsix")"
for required in \
  'extension.vsixmanifest' \
  'extension/package.json' \
  'extension/dist/src/extension.js' \
  'extension/syntaxes/scarp.tmLanguage.json' \
  'extension/language-configuration.json'; do
  if ! grep -Fxq "$required" <<< "$entries"; then
    echo "Required VSIX member missing: $required" >&2
    exit 1
  fi
done

# Never leak source files, test fixtures, CI workflows, release approvals or
# developer-side scripts into the installable VSIX.
if grep -E '^extension/(release-requests|compiler|test|\.github|\.vscode|site|docs|src|scripts|node_modules)/|\.(ts|map)$|^extension/package-lock\.json$' <<< "$entries"; then
  echo "Refusing VSIX containing internal source, test or workflow files." >&2
  exit 1
fi

VERSION="$version" unzip -p "$vsix" extension/package.json |
  VERSION="$version" node -e '
    const fs = require("node:fs");
    const p = JSON.parse(fs.readFileSync(0, "utf8"));
    if (p.publisher !== "ScarpLang" || p.name !== "scarp" ||
        p.version !== process.env.VERSION || p.main !== "./dist/src/extension.js") {
      console.error("VSIX publisher/name/version/entrypoint do not match Scarp.");
      process.exit(1);
    }
  '

if ! unzip -p "$vsix" extension.vsixmanifest |
    grep -Fq 'Microsoft.VisualStudio.Code.PreRelease'; then
  echo "Refusing stable-marked VSIX: pre-release marker is missing." >&2
  exit 1
fi
