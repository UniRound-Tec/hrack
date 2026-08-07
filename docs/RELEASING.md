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
- The application and installer use the Vibing icon rather than Electron's default icon.
- All black, white, and macOS template tray PNGs exist in the packaged resources directory.
- The packaged application starts, creates a Tray instance, and loads a non-empty 16×16 image.
- The installer product version matches `package.json`.
- The installer and blockmap both exist.

`scripts/assert-packaged-tray-assets.cjs` runs inside electron-builder's `afterPack` phase, so even direct packaging cannot silently omit tray assets. `scripts/verify-packaged-tray.cjs` performs the runtime Tray check. `scripts/release-win.ps1` composes all release checks and copies the verified artifacts.

## Delivery checklist

1. Run `npm run release:win` and require a zero exit code.
2. Deliver only `artifacts/Vibing-Setup-<version>.exe`.
3. Include the SHA-256 printed by the release command.
4. If the signature status is not `Present`, explicitly warn that Windows may show a security prompt.
5. Never deliver an installer created before the latest source change.

macOS and Linux packaging must gain equivalent signed/notarized package commands and runtime asset checks before those artifacts are distributed.

## GitHub Release workflow

Windows releases are published from an annotated `vX.Y.Z` tag by
`.github/workflows/release.yml`. The workflow checks that the tag exactly matches
the version in `package.json`, installs from `package-lock.json`, runs typechecks,
and delegates packaging to the guarded `release:win` command above. It uploads:

- `Vibing-Setup-<version>.exe`
- `Vibing-Setup-<version>.exe.blockmap`
- `Vibing-Setup-<version>.exe.sha256`

Create a release commit before tagging:

```powershell
npm version 0.2.3 --no-git-tag-version
# Update CHANGELOG.md, commit, and push the release commit first.
git tag -a v0.2.3 -m "Vibing v0.2.3"
git push origin v0.2.3
```

For a local rehearsal of the same tag/version gate and Windows artifact build:

```powershell
npm run release:github:win -- -TagName v0.2.3
```

The manual workflow dispatch is only for retrying an existing tag. It does not
create tags or publish code that is not already committed. GitHub Release creation
fails rather than replacing an existing release with the same tag.
