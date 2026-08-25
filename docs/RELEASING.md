# Release guide

Do not invoke `electron-builder` manually for a deliverable. The supported Windows release entry is:

```powershell
npm run release:win
```

`npm run build:win` is an alias of the same guarded release flow; it cannot bypass validation.

The command reads the version from `package.json`, builds into an isolated temporary directory, validates the result, and only then replaces the files in `artifacts/`.

## Changing the version

Update both `package.json` and `package-lock.json` without creating a Git tag:

```powershell
npm version 0.1.1 --no-git-tag-version
npm run release:win
```

## Hard release gates

The Windows release fails before delivery when any of these conditions is not met:

- NSIS is a guided installer (`oneClick: false`).
- The installation directory can be changed.
- The application and installer use the HRack icon rather than Electron's default icon.
- All black, white, and macOS template tray PNGs exist in the packaged resources directory.
- Remote source submodules, prior build outputs, development state, logs, and local `*.dsh` data never enter `app.asar`.
- The packaged application starts, creates a Tray instance, and loads a non-empty 16×16 image.
- The installer product version matches `package.json`.
- The installer, blockmap, and `latest.yml` all exist.
- `latest.yml` matches `package.json`, references the exact installer filename, and contains SHA-512 metadata.
- The packaged `app-update.yml` points to the public `UniRound-Tec/hrack` GitHub repository and contains no credentials.

`scripts/assert-packaged-tray-assets.cjs` runs inside electron-builder's `afterPack` phase, so even direct packaging cannot silently omit tray assets. `scripts/verify-packaged-tray.cjs` performs the runtime Tray check. `scripts/release-win.ps1` composes all release checks and copies the verified artifacts.

## Delivery checklist

1. Run `npm run release:win` and require a zero exit code.
2. For direct installer delivery, use `artifacts/HRack-Setup-<version>.exe`. For a GitHub Release, keep the installer, blockmap, SHA-256 file, and `latest.yml` together.
3. Include the SHA-256 printed by the release command.
4. If the signature status is not `Present`, explicitly warn that Windows may show a security prompt.
5. Never deliver an installer created before the latest source change.

The guarded macOS and Linux commands perform equivalent runtime/resource and update-metadata checks. macOS artifacts are currently unsigned, so signing/notarization is still required before production auto-install can be considered supported there.

## GitHub Release workflow

Windows releases are published from an annotated `vX.Y.Z` tag by
`.github/workflows/release.yml`. The workflow checks that the tag exactly matches
the version in `package.json`, installs from `package-lock.json`, runs typechecks,
and delegates packaging to the guarded `release:win` command above. It uploads:

- `HRack-Setup-<version>.exe`
- `HRack-Setup-<version>.exe.blockmap`
- `HRack-Setup-<version>.exe.sha256`
- `latest.yml`
- `HRack-<version>-macos-arm64.dmg`, its blockmap, and SHA-256
- `HRack-<version>-macos-arm64.zip`, its blockmap, and SHA-256
- `latest-mac.yml`
- `HRack-<version>-linux-x64.AppImage` and SHA-256
- `HRack-<version>-linux-x64.deb` and SHA-256
- `latest-linux.yml`

The workflow requires exactly these 16 non-empty assets before creating the Release. A tag with a prerelease suffix (for example `v0.3.1-beta.1`) is published as a GitHub prerelease; stable HRack clients ignore prereleases.

## Application update contract

Packaged HRack clients check the public `UniRound-Tec/hrack` Release feed after a 10-second startup delay and every six hours thereafter. New stable versions download in the background; the settings page offers “Restart and install” after the download completes. Development builds do not contact the update service.

Never upload only the installer/package files. `electron-updater` discovers releases through the platform metadata file, and every file referenced by that metadata must be attached to the same GitHub Release. The guarded release scripts validate this before copying anything into `artifacts/`.

`v0.3.0` predates this client-side updater. The first release containing the updater must be a later version and include all metadata assets; it becomes the baseline that can receive subsequent updates.

Create a release commit before tagging:

```powershell
npm version 0.2.3 --no-git-tag-version
# Update CHANGELOG.md, commit, and push the release commit first.
git tag -a v0.2.3 -m "HRack v0.2.3"
git push origin v0.2.3
```

For a local rehearsal of the same tag/version gate and Windows artifact build:

```powershell
npm run release:github:win -- -TagName v0.2.3
```

The manual workflow dispatch is only for retrying an existing tag. It does not
create tags or publish code that is not already committed. GitHub Release creation
fails rather than replacing an existing release with the same tag.

The guarded Windows packager always passes `--publish never` to electron-builder.
This prevents tag-aware CI environments from publishing before validation; only
the final workflow step may create or upload a GitHub Release.

Icon validation does not require Electron's development executable to exist on
the runner. The release gate always checks the configured source icon and that
the installer and packaged application use the same icon; it additionally
compares against Electron's default icon when that local reference is available.
