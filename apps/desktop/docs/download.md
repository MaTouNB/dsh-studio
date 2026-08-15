# Download

DSH Studio is distributed from the [GitHub Releases page](https://github.com/MaTouNB/dsh-studio/releases). Every release publishes both installers — the macOS arm64 DMG and the Windows x64 NSIS installer — plus `SHA256SUMS.txt` and `runtime-manifest.json`. The release title names the exact `desktop-v<version>` tag and links the signed (or unsigned, during the alpha period) checksums that accompany it.

## Demo

![DSH Studio demo](demo.gif)

A short look at the onboarding page and the plugin center (Discover tab).

## Artifacts

| File | Platform | Format |
|---|---|---|
| `DSH Studio-<version>-mac-arm64.dmg` | macOS arm64 | Disk image |
| `DSH Studio-<version>-win-x64.exe` | Windows x64 | NSIS installer |
| `SHA256SUMS.txt` | all | SHA-256 digests of the installers |
| `runtime-manifest.json` | all | Exact staged-runtime versions and tree hashes |

The alpha builds are unsigned; macOS Gatekeeper and Windows SmartScreen show warnings. See [security.md](security.md) for what that means, and [troubleshooting.md](troubleshooting.md) if a warning blocks installation.

## Verify a download

`SHA256SUMS.txt` lists the digest of every installer. On macOS:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

On Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 "DSH Studio-<version>-win-x64.exe"
```

Compare the output with the `SHA256SUMS.txt` entry. `runtime-manifest.json` names the bundled Harness version and the pinned Node and pnpm, so you can confirm which runtime a release ships before installing.

## Which version to pick

The first public release is `desktop-v0.1.0-alpha.1`. Alpha releases carry no stability guarantee; see [release.md](release.md) for the version and tag contract.
