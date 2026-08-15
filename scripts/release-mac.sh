#!/usr/bin/env bash

set -euo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_path="$workspace/package.json"
version="$(node -p "require('$package_path').version")"
arch="${HRACK_MAC_ARCH:-${VIBING_MAC_ARCH:-arm64}}"
artifact_dir="$workspace/artifacts"
image_name="HRack-${version}-macos-${arch}.dmg"
release_root="${TMPDIR:-/tmp}"
release_root="${release_root%/}"
release_dir="$(mktemp -d "$release_root/hrack-release-mac.XXXXXX")"
mount_dir="$release_dir/mount"
mounted=false

cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$mount_dir" -quiet || true
  fi
  if [[ -d "$release_dir" && "$release_dir" == "$release_root"/hrack-release-mac.* ]]; then
    rm -rf -- "$release_dir"
  fi
}
trap cleanup EXIT

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'macOS packaging must run on macOS.' >&2
  exit 1
fi
if [[ "$arch" != arm64 && "$arch" != x64 ]]; then
  echo "Unsupported macOS architecture: $arch" >&2
  exit 1
fi

cd "$workspace"
npm --prefix "$workspace/dsh-runtime" ci --ignore-scripts
# --ignore-scripts 跳过了 node-pty 的 postinstall；npm tarball 会剥离 unix 执行位，
# 这里显式恢复 prebuilds/<plat>-<arch>/spawn-helper 的 +x，否则打包后的 dsh host
# 在 PTY spawn 时会失败（host ready-check 不涉及 PTY，e2e 抓不到）。
node "$workspace/dsh-runtime/node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs"
npm run build

CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder \
  --mac dmg \
  "--$arch" \
  --publish never \
  "--config.directories.output=$release_dir"

image_path="$release_dir/$image_name"
blockmap_path="$image_path.blockmap"
app_path="$(find "$release_dir" -maxdepth 3 -type d -name 'HRack.app' -print -quit)"
executable_path="$app_path/Contents/MacOS/HRack"
info_plist="$app_path/Contents/Info.plist"

for required in "$image_path" "$blockmap_path" "$executable_path" "$info_plist"; do
  if [[ ! -e "$required" ]]; then
    echo "Release output is missing: $required" >&2
    exit 1
  fi
done

bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist")"
bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist")"
bundle_icon="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$info_plist")"
# Bundle id remains stable across the rebrand so existing installations upgrade.
if [[ "$bundle_id" != com.vibing.app ]]; then
  echo "Unexpected bundle identifier: $bundle_id" >&2
  exit 1
fi
if [[ "$bundle_version" != "$version" ]]; then
  echo "Bundle version $bundle_version does not match package version $version." >&2
  exit 1
fi
if [[ -z "$bundle_icon" || ! -f "$app_path/Contents/Resources/$bundle_icon" ]]; then
  echo "Packaged application icon is missing: $bundle_icon" >&2
  exit 1
fi
arch_pattern="$arch"
if [[ "$arch" == x64 ]]; then
  arch_pattern=x86_64
fi
if ! file "$executable_path" | grep -q "$arch_pattern"; then
  echo "Packaged executable does not contain the expected $arch architecture." >&2
  exit 1
fi

hdiutil verify "$image_path"
mkdir -p "$mount_dir"
hdiutil attach "$image_path" -readonly -nobrowse -mountpoint "$mount_dir" >/dev/null
mounted=true

mounted_executable="$mount_dir/HRack.app/Contents/MacOS/HRack"
if [[ ! -x "$mounted_executable" ]]; then
  echo 'Mounted DMG does not contain an executable HRack.app.' >&2
  exit 1
fi
node "$workspace/scripts/verify-packaged-tray.cjs" "$mounted_executable"

# extraResources 传输链路（npm ci → electron-builder copyDir）不得丢失执行位；
# 这是 dsh host 内 PTY spawn 的硬依赖。
mounted_spawn_helper="$mount_dir/HRack.app/Contents/Resources/dsh-runtime/node_modules/node-pty/prebuilds/darwin-$arch/spawn-helper"
if [[ ! -x "$mounted_spawn_helper" ]]; then
  echo "Packaged dsh runtime spawn-helper is missing or not executable: $mounted_spawn_helper" >&2
  exit 1
fi

hdiutil detach "$mount_dir" -quiet
mounted=false

mkdir -p "$artifact_dir"
cp -f "$image_path" "$artifact_dir/$image_name"
cp -f "$blockmap_path" "$artifact_dir/$image_name.blockmap"

final_image="$artifact_dir/$image_name"
digest="$(shasum -a 256 "$final_image" | awk '{print $1}')"
printf '%s  %s\n' "$digest" "$image_name" > "$final_image.sha256"

size_mib="$(du -m "$final_image" | awk '{print $1}')"
printf 'macOS release image verified:\n'
printf '  Path: %s\n' "$final_image"
printf '  Architecture: %s\n' "$arch"
printf '  Version: %s\n' "$version"
printf '  Size: %s MiB\n' "$size_mib"
printf '  SHA256: %s\n' "$digest"
printf '  Signing: unsigned\n'
printf '  DMG integrity: verified\n'
printf '  Packaged runtime/tray: verified\n'
