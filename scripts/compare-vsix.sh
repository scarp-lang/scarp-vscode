#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: compare-vsix.sh <verified-build.vsix> <release-asset.vsix>" >&2
  exit 2
fi

# Python zipfile looks up member names literally. `unzip -p archive
# [Content_Types].xml` treats square brackets as a wildcard pattern and
# silently returns no payload for that mandatory VSIX metadata entry.
# Previous process-substitution comparisons therefore ignored modifications
# to this file, despite comparing the archive member inventory.
python3 - "$1" "$2" <<'PY'
import hashlib
import sys
import zipfile


def entries(archive):
    names = archive.namelist()
    if len(names) != len(set(names)):
        raise ValueError("VSIX contains duplicate ZIP entries")
    return set(names)


def sha256(archive, member):
    digest = hashlib.sha256()
    # Streaming avoids unbounded decompressed memory from an unsafe asset.
    with archive.open(member, "r") as reader:
        for chunk in iter(lambda: reader.read(65536), b""):
            digest.update(chunk)
    return digest.digest()


try:
    with zipfile.ZipFile(sys.argv[1]) as built, zipfile.ZipFile(sys.argv[2]) as attached:
        first = entries(built)
        second = entries(attached)
        if first != second:
            raise ValueError("Existing GitHub release VSIX has a different file inventory")
        for name in sorted(first):
            original = built.getinfo(name)
            uploaded = attached.getinfo(name)
            if (original.is_dir() != uploaded.is_dir() or
                    original.file_size != uploaded.file_size or
                    not original.is_dir() and sha256(built, name) != sha256(attached, name)):
                raise ValueError("Existing GitHub release VSIX has altered payload: " + name)
except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, EOFError) as error:
    print("Scarp VSIX comparison refused: " + str(error), file=sys.stderr)
    sys.exit(1)
PY
