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

# Validate the first-upload archive itself, not just the comparator for an
# existing GitHub release asset. ZIP readers disagree on duplicate member
# names, and unsafe paths must never reach package consumers.
python3 - "$vsix" <<'PY'
import stat
import sys
import zipfile

try:
    with zipfile.ZipFile(sys.argv[1]) as archive:
        seen = set()
        for entry in archive.infolist():
            name = entry.filename
            if name in seen:
                raise ValueError("Duplicate VSIX ZIP member: " + name)
            seen.add(name)
            pieces = name.rstrip("/").split("/")
            if (not name or name.startswith("/") or "\\" in name or
                    any(part in ("", ".", "..") for part in pieces) or
                    ":" in pieces[0]):
                raise ValueError("Unsafe VSIX ZIP member path: " + name)
            if entry.flag_bits & 1:
                raise ValueError("Encrypted VSIX ZIP member: " + name)
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("Symlinked VSIX ZIP member: " + name)
        if "[Content_Types].xml" not in seen:
            raise ValueError("Required VSIX metadata missing: [Content_Types].xml")
except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, EOFError) as error:
    print("Refusing unsafe VSIX archive: " + str(error), file=sys.stderr)
    sys.exit(1)
PY

entries="$(unzip -Z1 "$vsix")"
for required in \
  'extension.vsixmanifest' \
  'extension/package.json' \
  'extension/dist/src/extension.js' \
  'extension/syntaxes/scarp.tmLanguage.json' \
  'extension/snippets/scarp.code-snippets' \
  'extension/language-configuration.json'; do
  if ! grep -Fxq "$required" <<< "$entries"; then
    echo "Required VSIX member missing: $required" >&2
    exit 1
  fi
done

# Never leak source files, test fixtures, CI workflows, release approvals or
# developer-side scripts into the installable VSIX.
if grep -E '^extension/(release-requests|compiler|test|\.github|\.vscode|\.vscode-test|site|docs|src|scripts|node_modules)/|\.(ts|map)$|^extension/package-lock\.json$' <<< "$entries"; then
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
