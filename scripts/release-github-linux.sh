#!/usr/bin/env bash

set -euo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag_name="${1:-${GITHUB_REF_NAME:-}}"
version="$(node -p "require('$workspace/package.json').version")"
expected_tag="v$version"

if [[ -z "$tag_name" ]]; then
  echo 'A release tag is required. Pass vX.Y.Z or set GITHUB_REF_NAME.' >&2
  exit 1
fi
if [[ "$tag_name" != "$expected_tag" ]]; then
  echo "Release tag $tag_name does not match package.json version $version (expected $expected_tag)." >&2
  exit 1
fi

cd "$workspace"
npm run typecheck
npm run release:linux

for required in \
  "$workspace/artifacts/HRack-${version}-linux-x64.AppImage" \
  "$workspace/artifacts/HRack-${version}-linux-x64.AppImage.sha256" \
  "$workspace/artifacts/HRack-${version}-linux-x64.deb" \
  "$workspace/artifacts/HRack-${version}-linux-x64.deb.sha256"; do
  if [[ ! -f "$required" ]]; then
    echo "Release output is missing: $required" >&2
    exit 1
  fi
done

printf 'GitHub Linux release assets ready for %s:\n' "$tag_name"
printf '  %s\n' "$workspace/artifacts/HRack-${version}-linux-x64.AppImage"
printf '  %s\n' "$workspace/artifacts/HRack-${version}-linux-x64.AppImage.sha256"
printf '  %s\n' "$workspace/artifacts/HRack-${version}-linux-x64.deb"
printf '  %s\n' "$workspace/artifacts/HRack-${version}-linux-x64.deb.sha256"
