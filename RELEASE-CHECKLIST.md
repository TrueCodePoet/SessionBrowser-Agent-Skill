# Public Release Checklist

- [ ] Copy this folder into a new Git repository; do not publish the parent workspace.
- [ ] Confirm `git status` contains no `node_modules`, `test-results`, browser profiles,
      vault files, screenshots, storage state, `.env` files, or personal data.
- [ ] Run `npm ci` and `npm test` on a clean Windows checkout.
- [ ] Review `extension/manifest.json` permissions and keep the extension ID out of
      the native-host manifest until the user installs the extension locally.
- [ ] Review the native-host launcher and HKCU registration behavior on a clean user
      account. Do not register with HKLM or require administrator elevation.
- [ ] Publish the repository with a license selected by the owner. This package does
      not add a license on the owner's behalf.
- [ ] Configure GitHub private Security Advisories before announcing the repository.
- [ ] Replace placeholder repository links after the new repository URL exists.
- [ ] Document supported Windows, Node.js, PowerShell, Edge, and Chrome versions.
- [ ] Do not claim that Playwright or the connector is undetectable, a vault, or a
      sandbox against same-user malware.