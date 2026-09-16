# Connect To An Existing Browser

The selected-tab connector works with normal Microsoft Edge and Google Chrome on
Windows. It does not launch a browser, attach a debugger, copy cookies, override
`navigator.webdriver`, or change request headers. Existing browser profiles and
sessions remain under the user's control. The existing headed/headless Playwright
implementation is unchanged and remains available.

This is not universal attachment to any process or window. Install the extension
in each browser profile you want to use. Browser-internal pages, extension store
pages, local files, PDFs without a normal DOM, Firefox, Safari, and InPrivate or
Incognito windows are not supported in this version. Managed-browser policies
may prevent unpacked extensions or Native Messaging.

## One-Time Setup

1. In your normal Edge, open `edge://extensions`. For Chrome use
   `chrome://extensions`.
2. Enable **Developer mode**, choose **Load unpacked**, and select the `extension`
   directory from this package checkout (for example,
   `C:\src\session-browser\extension`).
3. Copy the extension's 32-character **ID** from that page. It is not a secret.
4. Run the registration command below in the workspace terminal, replacing the
   example ID with the browser's actual ID. The agent may perform registration
   after you provide the ID and identify Edge or Chrome.

```powershell
node .github/skills/session-browser/scripts/register-connector.mjs --browser edge --extension-id YOUR_EXTENSION_ID
```

Use `--browser chrome` for Chrome. Default connection profiles are `attached-edge`
and `attached-chrome`. The optional `--profile name` changes the pipe profile.

Registration writes a non-secret native-host manifest, config, and command launcher
under `%LOCALAPPDATA%/SessionBrowser/connector/<browser>/`, and registers only
`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.session_browser.connector`
(or the Google Chrome equivalent). No administrator privileges are needed. The
allowlist contains only the supplied extension ID. No TCP port is opened.

The launcher references this package checkout and the installed Node executable. Re-run
registration after moving the workspace or Node installation. Only one connector
per registered browser can be active at a time; disconnect before switching to
another profile in that browser. Edge and Chrome can connect concurrently because
their default CLI profiles differ.

Chrome/Edge supplies the calling extension origin as a native-host process
argument. The host validates that origin against the locally registered extension
ID before accepting commands. This origin is not a secret, but process arguments
can be visible to local diagnostic tools; do not run the connector on a shared
Windows account. No credentials or page contents are placed in that argument.

## Share And Use

1. Open the desired site in a normal browser window and log in yourself, including
   MFA. Do not paste credentials into chat or share a filled login form.
2. Open the **Session Browser Connector** extension popup while that tab is active.
3. Leave **Allow page controls** off for read-only access, or enable it to authorize
   page actions. Click **Share This Tab**. Wait for **connected** in the popup.
4. Ask the agent to use the shared tab. These commands reconnect to the browser's
   native host; do not run `serve` for an attached profile.

```powershell
'{"command":"status"}' | node .github/skills/session-browser/scripts/browser.mjs send - --profile attached-edge
'{"command":"snapshot"}' | node .github/skills/session-browser/scripts/browser.mjs send - --profile attached-edge
'{"command":"click","role":"button","name":"Search"}' | node .github/skills/session-browser/scripts/browser.mjs send - --profile attached-edge
```

The extension badge reads **READ** or **ACT** for shared tabs. You may share tabs
across multiple normal windows in the same browser profile. `tabs` lists only
shared tab IDs, origins, and access levels; `useTab` selects one of those IDs.
No unshared tab list or titles are exposed to the agent.

**Stop Sharing** revokes one tab. **Disconnect All** revokes all tabs and closes the
native connection. The CLI's `stop` does the same without closing browser windows.
Closing a shared tab, navigating it to another origin, or losing the native
connection revokes permission. Same-origin navigation retains sharing. An action
already dispatched to the page may finish before revocation; inspect the page
before retrying any timed-out or interrupted action.

## Supported Commands

- Connection: `status`, `tabs`, `useTab`, `stop`.
- Read access: `snapshot`, `wait` for a visible locator.
- With controls enabled: `click`, `fill`, `select`, `check`, `scroll`, and same-origin `goto`.
- Locators: `selector`, `role` plus exact `name`, or exact `label`. One visible match
   is required. CSS selectors are limited in length and comma count to reduce
   accidental expensive queries. Accessible-name support is deliberately simpler
   than Playwright's.

No `eval`, raw HTML, cookies, credential reads, network diagnostics, screenshots,
downloads, uploads, background-tab discovery, or automatic login are available in
connected mode. Other Playwright commands return a generic failure. `goto` outside
the shared origin is refused; navigate and share the destination manually.

The connector's page actions run in the extension's isolated world and use ordinary
DOM events. Some sites require trusted input or have complex frame/shadow-DOM
controls that are not supported. Perform those interactions manually. Attaching
this extension does not guarantee a site permits or accepts automated actions.

## Privacy And Limits

The extension requests only `activeTab`, `scripting`, and `nativeMessaging`. It has
no blanket host permissions, debugger access, cookies API, external message
listener, persistent content scripts, or remote code. Sharing grants are held in
memory and bound to a tab and exact origin. Native messages and CLI commands are
bounded and serialized. Raw errors and filled form values are not returned.

Credential and payment fields are blocked from filling, using both field metadata
and password-form detection. This is not a comprehensive classifier for arbitrary
forms. Page text can contain financial or personal information, including secrets
rendered outside inputs. Share only authorized pages. Never ask the agent to read
password-manager pages or reveal passwords. The agent must still obtain explicit
confirmation before purchases, transfers, publishing, deletion, and account changes.

There is no vault access in connected mode. Browser login and MFA are performed
manually; the normal browser manages its own session. A process running as the same
Windows user could issue commands to the pipe while sharing is enabled, so local
OS access remains trusted. This is not a sandbox against malicious local software.

## Remove

Disconnect first, then remove the extension from the browser. To unregister its
native host, use the same registration command with `--uninstall`. This removes
only the selected browser's current-user native-host registry key; generated
non-secret files can be removed from the connector directory afterward.

## Validation

Run `npm test` from this package directory. Tests cover native framing, origin and
read/control grants, revocation, protected-field handling on actual pages, native
host CLI forwarding, and registration planning. They use synthetic data, not
personal tabs or credentials. Real browser installation and site login remain
user-driven checks.