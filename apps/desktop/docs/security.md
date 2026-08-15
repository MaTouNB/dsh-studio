# Security

DSH Studio is an unofficial, community-maintained desktop client. It is not affiliated with or endorsed by DeepSeek. Install only releases from the [GitHub Releases page](https://github.com/MaTouNB/dsh-studio/releases), verify the checksums ([download.md](download.md)), and treat any other source as untrusted.

## Alpha signing status

The alpha installers are unsigned. macOS Gatekeeper and Windows SmartScreen warn accordingly. An unsigned warning is expected for alpha builds; if an installer fails checksum verification or the warning names a publisher other than an identity you trust, do not install it — report the anomaly instead ([troubleshooting.md](troubleshooting.md)).

## Per-launch loopback authentication

The desktop app runs its own Harness child on a loopback address with a per-launch random secret. The window exchanges the secret for an HttpOnly, SameSite=Strict cookie; static assets, API calls, SSE, and WebSocket upgrades all reject requests without that cookie, and state-changing requests must also carry the expected loopback Origin. The secret is never written to logs.

## Credentials and diagnostics

API keys and credentials are stored by the harness credential service under the DSH home and never appear in exported diagnostics: the diagnostic zip excludes credentials, environment values, session logs, prompts, and workspace content by construction. Review a diagnostic export before sharing it, since it contains platform facts and configuration.

## Plugin management

Installed plugins run arbitrary code in the Harness process. Install scripts are disabled by default and only run after an explicit "Allow install scripts" confirmation ([../README.md](../README.md)); review a plugin's source and npm correspondence before installing. Removal only touches desktop-profile-owned third-party dependencies.

## Reporting

For security issues, do not file a public issue: email the repository maintainers (the contact on the GitHub profile of the project owner) with reproduction steps. For non-security bugs, use the issue tracker.
