# Code signing policy

## Current status

Yept 0.9.0 Windows packages are unsigned. macOS packages are experimental local builds without an Apple Developer ID signature or notarization. A local ad-hoc signature is not a verified publisher identity. No signing provider has been enabled in the build configuration, and there is no public installer release for this tree yet.

Read the status attached to the specific release you download. Do not assume that a later version is signed merely because this policy exists.

## Responsibility and release approval

Selva Subramaniam maintains Yept and is responsible for approving its releases. A release must be reviewed, built from an identified source revision and checked before publication. Dependency licences and upstream notices must be preserved. Outside contributions require review before they are included in a release.

If a signing service is introduced, each release will require an explicit approval before signing. Signing credentials must stay outside the repository and must not be available to untrusted pull-request builds. The release notes will identify the signing provider and publisher that users should expect to see. These are release requirements; this page does not assert that signing automation is already installed.

The intended Windows service is [SignPath Foundation](https://signpath.org/terms), subject to eligibility and acceptance. It is not currently providing signing for Yept. Its requirements and restrictions must be satisfied before that status changes. Apple distribution would require separate signing and notarization work.

The [approved tag-build workflow](../.github/workflows/release.yml) requires a manual dispatch, an explicit approval checkbox and a version tag whose commit is already on `main`. It reuses the validation jobs and keeps packages as short-lived Actions artifacts. It does not sign packages or publish GitHub Releases. On this private GitHub Free repository, that manual confirmation is not an independent required-reviewer gate. See [the build instructions](testing.md#manually-approved-tag-builds) for the exact checks and retention periods.

## Check a download

Obtain packages from this repository's Releases page when available. Check the version, platform and signing statement there. If a release supplies SHA-256 checksums, compare the downloaded file with the checksum published alongside it:

```powershell
Get-FileHash -Algorithm SHA256 .\Yept-Setup-0.9.0.exe
Get-AuthenticodeSignature .\Yept-Setup-0.9.0.exe | Format-List Status,SignerCertificate
```

Replace the filename with the version you downloaded. On macOS, a checksum can be calculated with `shasum -a 256 path/to/download.dmg`. A matching hash checks file integrity; it does not create a signature or authenticate a publisher. Current Windows builds are expected to report `NotSigned`.

Operating-system warnings must be considered alongside the source and release status. Do not disable SmartScreen, Gatekeeper or certificate verification globally. The [macOS build guide](macos-build.md) describes local test builds; it does not establish that a package is suitable for trusted public distribution.

## Network activity and privacy

Yept has no telemetry or hosted collection-sync service. Sending requests contacts the API endpoints in the collection, including redirects and any requests issued by scripts. Git operations contact the configured repository remotes. Opening a web link uses the operating system's browser. Installing dependencies and building packages can download npm packages, Electron and packaging tools.

The maintainer does not receive collections, request contents, secrets or history through an application reporting service. Review diagnostic material yourself before sending a report. See [SECURITY](../SECURITY.md) for storage boundaries and private vulnerability reporting.

## Suspected compromised package

Do not run a package with an unexpected publisher, signature status or checksum. Report the version, download location and file hash to [selva_subramaniam@outlook.com](mailto:selva_subramaniam@outlook.com). Do not attach live credentials or real collections. A confirmed compromise will be communicated through the repository's security advisories or release notes as appropriate.
