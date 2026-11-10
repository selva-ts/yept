# Building and testing Yept on macOS

macOS builds must be made **on a Mac**. electron-builder refuses to package for macOS on Windows, and Electron's framework relies on symlinks and Apple code signing that Windows can't produce. These builds are for local testing: they are **not signed with an Apple Developer ID and not notarized** (that needs a paid Apple Developer Program membership).

## 1. One-time setup

- macOS 12 Monterey or later, on Apple Silicon or Intel.
- Command Line Tools for Git: `xcode-select --install`
- Node.js 24 LTS from https://nodejs.org (the macOS installer), then check `node -v`.

## 2. Get the code and build

```bash
git clone <repository URL> yept && cd yept
npm ci
npm run package:mac
```

`npm ci` downloads Electron for macOS (about 100 MB). The build writes to `dist/`:

| File | For |
|---|---|
| `Yept-0.9.0-mac-arm64.dmg` / `.zip` | Apple Silicon Macs |
| `Yept-0.9.0-mac-x64.dmg` / `.zip` | Intel Macs |

To build for one architecture, use `npm run package:mac-arch -- --arm64` for Apple Silicon or `npm run package:mac-arch -- --x64` for Intel.

The log will say `skipped macOS application code signing` — expected for a local build.

## 3. Install and first launch

1. Open the `.dmg` for your Mac and drag **Yept** to **Applications**.
2. Give it a local (ad-hoc) signature and clear the download flag. Apple Silicon won't start an app whose signature doesn't match its contents:

   ```bash
   xattr -cr /Applications/Yept.app
   codesign --force --deep --sign - /Applications/Yept.app
   ```

3. Open Yept from Applications. If macOS still says it can't verify the developer, right-click → **Open** → **Open** once.

To check the build without the UI:

```bash
/Applications/Yept.app/Contents/MacOS/Yept --self-test
```

All 8 lines should say `PASS`.

## 4. What to check on a Mac

Everything in [ui-test-checklist.md](ui-test-checklist.md) applies. Mac-specific points:

| # | Check | Expected |
|---|---|---|
| 1 | Title bar | Red/yellow/green buttons on the left, vertically centred in the bar; ☰ and Home sit to their right, not underneath. Dragging the bar moves the window; double-click zooms. |
| 2 | Menu bar at the top of the screen | **Yept** (About, Hide, Quit ⌘Q), **Edit**, **View** (zoom, full screen), **Window**. No Reload. |
| 3 | Shortcuts | ⌘S save, ⌘↩ send, ⌘K search, ⌘W close tab, ⌘C/⌘V/⌘Z in fields and editors, ⌘+ / ⌘- zoom. |
| 4 | Theme | **System** follows macOS Light/Dark (System Settings → Appearance), switching live; Light/Dark override it. |
| 5 | Local secrets | The first time a secret is stored, macOS may ask to allow access to the **"Yept Safe Storage"** keychain item — choose *Always Allow*. Secrets survive a restart. |
| 6 | HTTPS | Requests to sites trusted by macOS (including certificates you added to Keychain) work; self-signed ones fail with a TLS error unless allowed in the environment's TLS settings. |
| 7 | Git panel | Uses the `git` from the Command Line Tools and your saved Git credentials. |
| 8 | Where data lives | `~/Library/Application Support/yept/` (settings, history, local secrets). Nothing is written into collection folders except your saved requests. |
| 9 | Closing | Closing the window leaves Yept in the Dock (macOS convention); clicking the Dock icon reopens it. ⌘Q quits and asks first if there are unsaved edits. |

## Known limits of these builds

- Unsigned and not notarized: fine for your own Mac, but anyone else must repeat step 3. Wider distribution needs an Apple Developer ID and notarization.
- Yept's own shortcut hints in the UI still say *Ctrl* (for example under "Send the request"), although ⌘ works.
