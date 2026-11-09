# Security policy

## Reporting a vulnerability

Email [selva_subramaniam@outlook.com](mailto:selva_subramaniam@outlook.com) privately with the subject **Yept security report**. The maintainer, Selva Subramaniam, receives these reports. Do not use public issues or pull requests for an unpatched vulnerability.

Include the affected version or commit, operating system, impact and minimal reproduction using synthetic data. Include logs only after removing credentials, personal data and internal addresses. Do not send live tokens, real collections or production response bodies. If sensitive evidence is essential, first ask how to share it privately.

The maintainer will assess the report, coordinate a fix and agree on disclosure with the reporter. This is a small project without a guaranteed response time or paid security support. Follow up by email if you have not received a response. Ordinary bugs and feature requests belong in the repository's issue tracker.

## Supported versions

Security fixes target the current development branch and the newest published release, when one exists. Older previews have no guaranteed backports. This tree is 0.9.0 and has not yet been published as a public installer release. Prefer the newest source or release and include its exact version in reports.

## Data and trust boundaries

- Collections and shared environments are files in your chosen workspace. Git operations contact the remotes you configure.
- Personal settings, history, local overrides, secrets and cookie jars live in the app's user-data folder. Secret values and persistent cookies are encrypted through the operating system's credential protection. This is protection for local storage, not a defence against a compromised computer or another process running as you.
- History is redacted before storage. Unknown secrets and arbitrary response content can still be sensitive; review exports, screenshots and logs before sharing them.
- Imported scripts are not executed during import. Running a request can execute its scripts, including `bru.sendRequest` network calls. Inspect unfamiliar collections before sending requests. The QuickJS time limit is a resource safeguard, not a promise that every collection is trustworthy.
- Response HTML is displayed in a sandboxed preview. Requests, redirects and links should still be treated as untrusted input. Report any escape or unexpected access privately.
- There is no Yept account, telemetry endpoint or hosted collection-sync service.

See [architecture](docs/architecture.md) for the implementation and storage locations, and the [code signing policy](docs/code-signing.md) for package provenance. A valid checksum alone does not prove that a publisher is trusted.

## Testing responsibly

Reproduce issues against local fixtures or systems you own or are authorised to test. Do not use live credentials or third-party production systems. A report does not authorise access to another person's collections, repositories or services.
