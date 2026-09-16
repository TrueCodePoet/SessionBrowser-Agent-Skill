# Session Browser

An open-source, local Windows skill for agent-assisted web browsing with three
explicit modes:

- **Headed Playwright (default):** launches a dedicated visible Edge, Chrome, or
  Chromium profile and keeps it alive for a session.
- **Headless Playwright (explicit):** uses the same restricted command surface for
  unattended validation.
- **Connected normal browser:** a user-installed Edge/Chrome extension shares one
  selected tab with the local agent bridge. The normal browser profile and site
  identity remain untouched; no debugging port or user-agent spoofing is used.

This package is a local companion tool, not a hosted service, credential manager,
or security sandbox. Read [SECURITY.md](SECURITY.md) before using it with real
accounts.

This project is experimental and pre-1.0. The `private: true` package setting is
intentional: it prevents accidental npm publication. GitHub publication is the
supported distribution path. Review [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md)
before creating a public repository.

## Public Installation

### Agent-assisted installation

Point your coding agent at this repository and ask it to install the
`session-browser` skill in the consuming repository. It should copy this folder
to `.github/skills/session-browser/`, run `npm ci`, run `npm test`, and report
any missing Windows, Node.js, PowerShell, or browser prerequisites. After the
installation succeeds, the agent should read [SKILL.md](SKILL.md) before using
the skill.

### Manual installation

1. Clone or download this repository on Windows. Keep it in a trusted local
  directory; do not install it from an unreviewed archive.
2. Install Node.js 22 or newer and PowerShell 7. Confirm `node --version` and
  `pwsh --version`.
3. From the package directory run:

  ```powershell
  npm ci
  npm test
  ```

4. Use the default installed Microsoft Edge channel, or pass `--channel chrome`
  for installed Chrome. For Playwright Chromium, run `npm run install:browser`.
5. Read [SKILL.md](SKILL.md) for the agent workflow. Read
  [CONNECTOR.md](CONNECTOR.md) before connecting an existing browser.

The package is intended to be copied into a consuming repository at
`.github/skills/session-browser/`, or invoked directly from its checkout. Do not
copy `node_modules`, browser profiles, `%LOCALAPPDATA%\SessionBrowser`, vault
files, screenshots, storage state, or private transaction data into a repository.

## Quick Start

### Dedicated headed browser

```powershell
node .\scripts\browser.mjs serve --profile personal
```

In another terminal:

```powershell
'{"command":"status"}' | node .\scripts\browser.mjs send - --profile personal
'{"command":"goto","url":"https://example.com"}' | node .\scripts\browser.mjs send - --profile personal
'{"command":"snapshot"}' | node .\scripts\browser.mjs send - --profile personal
```

Headless is explicit:

```powershell
node .\scripts\browser.mjs serve --headless --profile ci
```

### Existing Edge or Chrome

The connector requires loading the unpacked `extension` directory, registering a
current-user Native Messaging host with the browser's generated extension ID,
and clicking **Share This Tab**. It never silently discovers or attaches to
browser windows. Follow [CONNECTOR.md](CONNECTOR.md) exactly.

## Credential Handling

Manual login and MFA are preferred. The optional Windows DPAPI credential broker
is for user-authorized form-login recipes only. Credentials are enrolled by the
user in a local PowerShell prompt and never belong in chat, source control,
command arguments, environment variables, fixtures, or issue reports. The broker
does not provide protection from malware or other processes running as the same
Windows user. Connected-browser mode does not read the vault.

Credential enrollment and retrieval require Windows DPAPI, a loaded Windows user
profile, and the same Windows user and machine that performed enrollment. The
credential file is not portable between users or machines. If the profile is
locked, unavailable, or copied elsewhere, enroll again locally rather than
weakening the protection. The username is metadata and is not encrypted by
PowerShell's `PSCredential` XML export; keep the vault directory private.

A standalone adaptation of the live-session concept in ProjectGenesis's
headless-playwright-browser-testing skill. The original remains untouched.
For user-approved access to existing normal Edge/Chrome tabs, see
[the selected-tab connector](./CONNECTOR.md). It is separate from the Playwright
launch modes described below and does not require browser debugging flags.
This implementation drops corporate batch orchestration, generated .NET runners,
raw evaluation, and secret-bearing evidence exports. Both modes use one Node
Playwright worker, with headed mode as the default.

## Requirements And Lifecycle

Windows, Node.js 22+, PowerShell 7, and installed Microsoft Edge (default).
Installed Chrome (`--channel chrome`) and Playwright Chromium (`--channel chromium`)
are alternatives. Chromium requires `npm run install:browser`; Edge/Chrome do not.
Follow [SKILL.md](./SKILL.md) for installation and startup. No MCP registration is
required: the skill sends JSON through a local Windows named pipe. There is no
HTTP listener or exposed CDP debugging port. This is a local companion service,
not a remotely accessible browser or a connection to your normal desktop profile.

The browser runs until the user closes it or sends `stop`. Reattach by sending
commands with the same `--profile`. Restart with `--headless` to switch modes.
Separate profile names isolate cookies and logins. Use the same browser channel
for an existing profile; use a new profile when changing browser engines/channels.

Local state is stored outside the repository:

```text
%LOCALAPPDATA%/SessionBrowser/
  profiles/<profile>/     Persistent browser data, sensitive
  vault/<alias>.credential.xml  DPAPI-protected password, local username metadata
  sites.json             Non-secret login recipes
  screenshots/           Sensitive screenshots, created only on request
```

Treat this entire directory as private. It inherits Windows user-profile access
controls. Do not sync, commit, upload, or expose it to other users. Browser cookies
are credentials too. Closing a browser does not revoke sessions or delete data.
Delete unwanted profile directories only after stopping their workers. Remove
screenshots when no longer needed. There is no automatic retention/deletion.

## Local Credential Enrollment

The user runs this themselves in a local terminal, outside agent capture:

```powershell
pwsh -NoProfile -File .github/skills/session-browser/scripts/credential-store.ps1 -Action Enroll -Alias example-personal
```

Enter the username and password in that prompt, never in chat. PowerShell's
Windows `Export-Clixml` protects the password with DPAPI for the current Windows
user and machine. The username is metadata, not encrypted by PSCredential export.
Re-enroll the same alias to rotate credentials. Use `-Action Remove` to delete it.
The broker's internal `Read` operation must never be invoked in agent-visible
terminal output; only the worker invokes it with stdout captured privately.

Create `%LOCALAPPDATA%/SessionBrowser/sites.json` locally using the non-secret
[example](./assets/sites.example.json). Entries use domain-plus-account aliases
for organization, but authorization uses exact HTTPS origins, not root-domain
wildcards. An identity provider must be explicitly included; approving a root
domain does not approve every subdomain.

Only add sites/accounts the user has authorized. Match selectors to the actual
login page and select a success marker that appears only after authentication.
The current broker supports a single-page username/password form in the main
frame. Multi-step SSO, passkeys, embedded-frame logins, and MFA require manual
headed login; persistent cookies can then be reused in either mode.

```powershell
'{"command":"login","site":"example.com/personal"}' | node .github/skills/session-browser/scripts/browser.mjs send -
```

During automated login, outbound requests are restricted to the recipe's exact
HTTPS origins, including form submission destinations. Service workers are
disabled so they cannot bypass this request guard. External resources may be
blocked, which can break some sites; prefer manual login rather than broadly
expanding the allowlist. Login returns `authenticated`, `already_authenticated`,
or `needs_user_action`. A missing recipe or invalid configuration returns a
generic command failure. Both login fields are cleared after the attempt.

## Command Reference

Each input is one JSON object with a `command`. Each response contains `ok` and
`result`, or a generic `error`. Never put secrets in any command. Commands are
serialized so snapshots cannot run concurrently with broker login.

| Command | Fields / Behavior |
| --- | --- |
| `status`, `tabs` | Mode, profile, active tab and URL paths without queries/fragments |
| `newTab` | Optional `url`; becomes active |
| `useTab` | `tab` from `tabs`; brings the page forward |
| `closeTab` | Closes active tab |
| `goto` | `url`, HTTP(S) only, no embedded username/password |
| `back` | Browser history back |
| `snapshot` | Bounded page text and control labels; no input values or raw HTML |
| `click` | Locator |
| `fill` | Locator and `text`, non-sensitive fields only |
| `press` | Locator and `key`: Enter, Tab, Escape, or arrow keys |
| `select` | Locator and `value` |
| `check` | Locator and optional boolean `checked` |
| `wait` | Locator; waits up to 10 seconds for visibility |
| `scroll` | Optional `y`, capped at 2,000 pixels per action |
| `screenshot` | Saves local viewport PNG; masks controls, refuses password pages |
| `login` | `site`, an exact recipe key |
| `diagnostics` | `action`: `start`, `read` (default), or `stop`; limited identity/header diagnostics |
| `stop` | Gracefully closes browser and worker; preserves profile |

Locators: `{"role":"button","name":"Search"}`, `{"label":"Search"}`, or
`{"selector":"#search"}`. There is deliberately no arbitrary evaluation, raw DOM,
cookie export, network body, console log, upload/download, or password-read command.
New tabs opened by sites are tracked and become active. JavaScript dialogs are
dismissed automatically. Native permission prompts and browser UI require the user.

Diagnostics are off by default. `start` watches the current tab's main-frame
document/fetch/XHR responses and retains only the last 20 metadata entries in
memory. `read` returns browser identity and the captured allowlisted request headers
(UA/client hints, language, accept/content type, fetch metadata, origin/referrer).
All URLs are reduced to origins. Cookies, authorization, custom headers, request
and response bodies, and input values are never returned. No network interception
or header rewriting is performed. `stop` detaches the listener and clears the buffer.
This cannot recover past requests, determine a site's private rejection rules,
or prove that cookies and other deliberately excluded metadata are valid.

## Security Boundary And Limitations

This service prevents ordinary tool responses from including filled form values,
broker-known credentials (including common encoded representations), and raw
Playwright errors. It does not persist command logs or traces. Raw exceptions
are suppressed because Playwright errors can contain input values.

This is defense in depth, not a proof that arbitrary web content is secret-free.
Screenshots, page text, and link labels can contain personal data; a malicious site
can transform secrets or render them into images. Unknown manually entered secrets
cannot be recognized reliably. Any agent with unrestricted OS access under the same
Windows account could read/decrypt the vault, bypass this interface, or inspect
browser memory. Strong isolation needs a separate user/process security boundary
and restricted agent tools; this first version does not claim that protection.

Do not copy normal-browser cookies, bypass CAPTCHA, spoof browser identity, or
disable certificate/security checks. Sites may reject Playwright even in headed
Chrome; a different user agent is not a guaranteed fix.

## Validation

```powershell
Push-Location .github/skills/session-browser
npm test
Pop-Location
```

Tests default to installed Edge; set `SESSION_BROWSER_TEST_CHANNEL=chromium` or
`chrome` to test an alternative. They briefly open visible windows to verify headed mode.
Tests use synthetic credentials and intercepted HTTPS fixtures, never real
accounts. They cover mode selection, persistent sessions, login origin checks,
broker use, sanitized output, and protected fields. Real-site login and credential
enrollment require user setup and must not be reported as verified by these tests.