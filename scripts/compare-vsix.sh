#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: compare-vsix.sh <verified-build.vsix> <release-asset.vsix>" >&2
  exit 2
fi

built="$1"
attached="$2"
test -f "$built" && test -f "$attached"

# File membership and uncompressed content must be identical; ZIP header
# timestamps/compression choices may differ across equivalent builds.
if ! diff -u <(unzip -Z1 "$built" | LC_ALL=C sort) \
             <(unzip -Z1 "$attached" | LC_ALL=C sort); then
  echo "Existing GitHub release VSIX has a different file inventory." >&2
  exit 1
fi

while IFS= read -r member; do
  [[ -z "$member" || "$member" == */ ]] && continue
  if ! cmp -s <(unzip -p "$built" "$member") \
              <(unzip -p "$attached" "$member"); then
    echo "Existing GitHub release VSIX has altered payload: $member" >&2
    exit 1
  fi
done < <(unzip -Z1 "$built")
