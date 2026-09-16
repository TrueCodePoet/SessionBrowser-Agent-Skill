# Contributing

## Before Opening A Pull Request

From this directory on Windows:

```powershell
npm ci
npm test
```

The suite uses synthetic credentials, intercepted test pages, temporary browser
profiles, and an installed Microsoft Edge channel. It must not access real
accounts. Do not add screenshots, browser profiles, storage state, vault files,
transaction exports, credentials, or personal data to the repository.

Changes affecting credentials, native messaging, extension permissions, origin
authorization, command handling, sanitization, or file paths require new tests
and an explicit security note in the pull request.

## Design Rules

- Keep headed Playwright as the default; headless is explicit.
- Keep connected-browser access explicit, per-tab, exact-origin, and read-only by
  default.
- Never add arbitrary page evaluation, cookie export, raw request bodies, or
  password reads to the agent-facing protocol.
- Never log secrets or place them in command arguments, environment variables,
  fixtures, tests, screenshots, or documentation.
- Preserve generic errors on model-facing paths when the underlying error may
  contain input values or private URLs.