# Code signing policy

## Current status

Yept ships unsigned Windows installers and macOS packages without Apple Developer ID signing or notarisation. Installer signing is not planned. An ad-hoc macOS signature permits local execution on Apple Silicon.

## Responsibility and release approval

Selva Subramaniam maintains Yept and is responsible for approving its releases. A release must be reviewed, built from an identified source revision and checked before publication. Dependency licences and upstream notices must be preserved. Outside contributions require review before they are included in a release.

The [approved tag-build workflow](../.github/workflows/release.yml) requires a manual dispatch, an explicit approval checkbox and a version tag whose commit is already on `main`. It reuses the validation jobs, keeps packages as short-lived Actions artifacts and generates a `SHA256SUMS.txt` manifest. The maintainer can attach the packages and manifest to an existing draft release. See the [build instructions](testing.md#manually-approved-tag-builds) for the checks and retention periods.

## Check a download

Obtain packages and `SHA256SUMS.txt` from [GitHub Releases](https://github.com/selva-ts/yept/releases) when available. Compare the package's SHA-256 with the value listed for its filename before installing.

```powershell
Get-FileHash -Algorithm SHA256 .\Yept-Setup-0.9.0.exe
Get-AuthenticodeSignature .\Yept-Setup-0.9.0.exe | Format-List Status,SignerCertificate
```

Replace the filename with the version you downloaded. On macOS, calculate the checksum with `shasum -a 256 path/to/download.dmg`. Matching hashes verify file integrity. Current Windows builds are expected to report `NotSigned`. See the [installation steps](user-guide.md#installing) for Windows and macOS prompts.

## Network activity and privacy

Yept has no telemetry or hosted collection-sync service. Sending requests contacts the API endpoints in the collection, including redirects and any requests issued by scripts. Git operations contact the configured repository remotes. Opening a web link uses the operating system's browser. Installing dependencies and building packages can download npm packages, Electron and packaging tools.

The maintainer does not receive collections, request contents, secrets or history through an application reporting service. Review diagnostic material yourself before sending a report. See [SECURITY](../SECURITY.md) for storage boundaries and private vulnerability reporting.

## Suspected compromised package

Report the version, download location and file hash privately using the instructions in [SECURITY](../SECURITY.md). A confirmed compromise will be communicated through the repository's security advisories or release notes as appropriate.
