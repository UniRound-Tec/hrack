#!/usr/bin/env bash

set -euo pipefail

workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_path="$workspace/package.json"
version="$(node -p "require('$package_path').version")"
arch="${HRACK_LINUX_ARCH:-x64}"
artifact_dir="$workspace/artifacts"
release_root="${TMPDIR:-/tmp}"
release_root="${release_root%/}"
release_dir="$(mktemp -d "$release_root/hrack-release-linux.XXXXXX")"

cleanup() {
  if [[ -d "$release_dir" && "$release_dir" == "$release_root"/hrack-release-linux.* ]]; then
    rm -rf -- "$release_dir"
  fi
}
trap cleanup EXIT

if [[ "$(uname -s)" != Linux ]]; then
  echo 'Linux packaging must run on Linux.' >&2
  exit 1
fi

case "$arch" in
  x64)
    deb_arch=amd64
    binary_arch_pattern='x86-64|x86_64'
    ;;
  arm64)
    deb_arch=arm64
    binary_arch_pattern='aarch64|ARM aarch64'
    ;;
  *)
    echo "Unsupported Linux architecture: $arch" >&2
    exit 1
    ;;
esac

for command in npm npx node file sha256sum dpkg-deb; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required release command is unavailable: $command" >&2
    exit 1
  fi
done

cd "$workspace"
npm --prefix "$workspace/dsh-runtime" ci --no-audit --no-fund
npm run build

CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder \
  --linux AppImage deb \
  "--$arch" \
  --publish never \
  "--config.directories.output=$release_dir"

image_name="HRack-${version}-linux-${arch}.AppImage"
deb_name="HRack-${version}-linux-${arch}.deb"
image_path="$release_dir/$image_name"
deb_path="$release_dir/$deb_name"
executable_path="$(find "$release_dir" -maxdepth 3 -type f -name hrack -path '*linux*unpacked*' -print -quit)"

for required in "$image_path" "$deb_path" "$executable_path"; do
  if [[ ! -f "$required" ]]; then
    echo "Release output is missing: $required" >&2
    exit 1
  fi
done
if [[ ! -x "$image_path" || ! -x "$executable_path" ]]; then
  echo 'Linux AppImage or unpacked application is not executable.' >&2
  exit 1
fi
if ! file "$executable_path" | grep -Eq "$binary_arch_pattern"; then
  echo "Packaged executable does not contain the expected $arch architecture." >&2
  file "$executable_path" >&2
  exit 1
fi

app_dir="$(dirname "$executable_path")"
dsh_bin="$app_dir/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
node_pty_root="$app_dir/resources/dsh-runtime/node_modules/node-pty"
node_pty_native=''
for candidate in \
  "$node_pty_root/build/Release/pty.node" \
  "$node_pty_root/prebuilds/linux-${arch}/pty.node"; do
  if [[ -f "$candidate" ]]; then
    node_pty_native="$candidate"
    break
  fi
done
for required in "$dsh_bin"; do
  if [[ ! -f "$required" ]]; then
    echo "Packaged DSH runtime is missing: $required" >&2
    exit 1
  fi
done
if [[ -z "$node_pty_native" ]]; then
  echo 'Packaged DSH node-pty native runtime is missing.' >&2
  exit 1
fi

deb_version="$(dpkg-deb --field "$deb_path" Version)"
deb_actual_arch="$(dpkg-deb --field "$deb_path" Architecture)"
if [[ "$deb_version" != "$version" ]]; then
  echo "Debian package version $deb_version does not match package version $version." >&2
  exit 1
fi
if [[ "$deb_actual_arch" != "$deb_arch" ]]; then
  echo "Debian package architecture $deb_actual_arch does not match $deb_arch." >&2
  exit 1
fi

extract_dir="$release_dir/appimage-extracted"
mkdir -p "$extract_dir"
(
  cd "$extract_dir"
  "$image_path" --appimage-extract >/dev/null
)
if [[ ! -x "$extract_dir/squashfs-root/AppRun" ]]; then
  echo 'AppImage extraction did not produce an executable AppRun.' >&2
  exit 1
fi

if [[ -n "${DISPLAY:-}" ]]; then
  node "$workspace/scripts/verify-packaged-tray.cjs" "$executable_path"
elif command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run -a node "$workspace/scripts/verify-packaged-tray.cjs" "$executable_path"
else
  echo 'Tray verification requires DISPLAY or xvfb-run.' >&2
  exit 1
fi

mkdir -p "$artifact_dir"
for source in "$image_path" "$deb_path"; do
  filename="$(basename "$source")"
  destination="$artifact_dir/$filename"
  cp -f "$source" "$destination"
  digest="$(sha256sum "$destination" | awk '{print $1}')"
  printf '%s  %s\n' "$digest" "$filename" > "$destination.sha256"
done

printf 'Linux release packages verified:\n'
printf '  Version: %s\n' "$version"
printf '  Architecture: %s\n' "$arch"
printf '  AppImage: %s\n' "$artifact_dir/$image_name"
printf '  Debian: %s\n' "$artifact_dir/$deb_name"
printf '  Packaged runtime/tray: verified\n'
