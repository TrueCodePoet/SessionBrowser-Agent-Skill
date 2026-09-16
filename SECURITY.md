# Security Policy

## Supported Versions

Only the latest version on the default branch is supported. This project is a
local Windows tool and is not intended to be exposed as a server or shared
multi-user service.

## Reporting A Vulnerability

Do not open a public issue for a suspected credential, browser-session, native
messaging, command-injection, path-traversal, or secret-redaction vulnerability.
Use the repository owner's private GitHub Security Advisory channel once this
package is published. Until a private channel is configured, keep the report
local and do not include credentials, cookies, screenshots, storage state, or
transaction data.

Include the package version, Windows version, Node.js version, browser/channel,
reproduction steps using synthetic data, impact, and a proposed mitigation.
Redact all secrets and personal data from reports.

## Security Model

The connector is deliberately local and user-mediated. It does not provide a
security boundary against software running as the same Windows user. Do not run
it as an administrator, expose a debugging port, publish the named pipe, or use
it on a shared Windows account. Review [README.md](README.md) and
[CONNECTOR.md](CONNECTOR.md) before use.