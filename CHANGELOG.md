# Changelog

## Unreleased

### Added

- Proxy settings: the system proxy (Windows settings, setup scripts and the usual environment variables), a manual HTTP proxy with a bypass list, or none, with optional Basic sign-in stored encrypted. HTTPS goes through CONNECT tunnels, and Network shows the proxy each request used.
- Client certificates for mutual TLS: a PFX, or a PEM certificate and key, per environment and host pattern, kept on this computer with the passphrase encrypted. Network shows the certificate's subject.

## 0.9.0

### Added

- Desktop HTTP client with Git-friendly Bruno OpenCollection files, local environments and secrets, and redacted request history.
- Desktop Git tools for reviewing and committing changes, fetching, pulling, syncing and switching branches.
- Collection runs with CSV or JSON data, repeat counts, delays, and JUnit XML and HTML reports.
- Digest, NTLMv2 and AWS Signature v4 authentication. OAuth2 supports client credentials, authorisation code with PKCE, the password grant and token renewal.
- Network diagnostics with reconstructed raw HTTP and code snippets for cURL, C#, PowerShell, JavaScript and Python.
- Response tools for filtering JSON, setting variables and secrets, saving response files, previewing media and comparing runs.
- VS Code extension source with shared request editing, sending and collection-runner support.
- Instructions for running collections in CI with Bruno CLI.

### Changed

- macOS CI builds Apple Silicon and Intel packages in separate jobs.

### Fixed

- Windows packaging checks now keep CI logs out of the app.
- Script and UI checks tolerate busy build machines more reliably.
