# Troubleshooting

This page covers the common failure modes of DSH Studio and how to collect the evidence to report them. For installation warnings, see [security.md](security.md); for the artifact list, see [download.md](download.md).

## Logs

The app writes rotating JSON lines under the platform log directory (macOS: `~/Library/Logs/DSH Studio/`; Windows: `%LOCALAPPDATA%\DSH Studio\logs\`). Each line carries a timestamp, stream, app version, Harness version, and lifecycle state; the secret and credential-shaped environment values are redacted before writing.

## Diagnostic export

The settings UI's "Export diagnostics" action writes a zip of the runtime manifest, redacted logs, platform facts, profile package names and versions, and the effective configuration — never credentials, environment values, session logs, prompts, or workspace content. Attach it to a bug report.

## The window never reaches the app

The window opens the harness web UI on a loopback port the child prints when ready. If the window stays blank, open the logs and check for a `failed` lifecycle state; the supervisor shows Retry / Open Logs / Export Diagnostics / Quit actions. A repeated crash within two minutes trips the protected failure state deliberately.

## Installation warnings

Gatekeeper ("cannot be opened because the developer cannot be verified") and SmartScreen ("Windows protected your PC") appear because the alpha installers are unsigned. Right-click → Open on macOS, or More info → Run anyway on Windows, after verifying the checksum. If the warning names a different publisher, stop and report it.

## A plugin install fails

Installs run the profile's own `dsh plugin` command against the desktop profile. A failed operation shows a diagnostic code in the Manage tab (for example `scripts-not-confirmed` when a package needs lifecycle scripts, or `launcher-failed` when pnpm failed). Retry after resolving the cause; the profile is only changed on a successful restart-required operation.

## Uninstall

macOS: drag the app to Trash. Windows: run the NSIS uninstaller from the installation directory or Programs and Features. The DSH home (`~/.dsh` on macOS, `%USERPROFILE%\.dsh` on Windows) holds sessions, settings, and installed plugins; removing it deletes that data.
