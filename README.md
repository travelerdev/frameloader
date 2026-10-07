# Frameloader

[www.frameloader.com](https://www.frameloader.com)

Drop an APK, a Windows app, or a Linux ARM64 build onto Frameloader and it shows up in your Steam Frame's library, under Non-Steam, ready to launch. Open source, cross-platform (macOS, Windows, Linux), and built on the same mechanism Valve's own SteamOS Devkit Client uses.

**Drop it in. It's in your library.**

## How it works

Frameloader does not touch Steam's shortcut files or require anything installed on the headset beyond Developer Mode. It speaks Valve's **SteamOS devkit protocol**:

1. **Pairing.** The headset runs a small pairing service on port 32000. Frameloader generates an RSA key, posts it to `/register`, and you approve the request on the headset (Settings → Developer → Pair new host). From then on it logs in over SSH with that key. You can also connect with the Developer Mode password instead.
2. **Upload.** Valve's device-side helper scripts (`devkit-utils`, MIT, vendored unmodified in `vendor/devkit-utils`) are copied to `~/devkit-utils` on the headset. `steamos-prepare-upload` creates `~/devkit-game/<id>/`, and your files are copied there over SFTP.
3. **Register.** `steam-client-create-shortcut` tells the running Steam client about the title and which runtime to use. Steam adds "Devkit Game: <id>" to your library, no restart needed.
4. **Launch.** `steam-devkit-rpc run-game` starts it, or you pick it from the headset's library.

| You drop | Runtime (Steam compat tool) | Status |
|---|---|---|
| `.apk` (arm64-v8a, API ≤ 30) | Lepton | Primary path. Each app runs in its own persistent Lepton container, so save data survives. |
| Windows `.exe` or a zip/folder with one | Proton Experimental or Proton (stable) | Works through FEX. Needs a Proton already installed on the headset. |
| Linux ARM64 build | Steam Linux Runtime 4 (ARM64) | Starts natively; self-contained builds only. |
| Linux x86-64 build | – | Refused: the Frame won't install the x86-64 runtime for sideloaded titles. |

For Android apps, Frameloader reads the manifest to pick a name and icon, refuses 32-bit-only and too-new APKs with a plain explanation, and writes Lepton's `lepton-show-flatscreen` marker for non-VR apps so they're actually visible. OBB files dropped with an APK go into `obb/` next to it.

## Using it

1. On the headset: Steam Settings → System → **Enable Developer Mode**, then Settings → Developer → **Set User Password**.
2. Open Frameloader. Headsets with Developer Mode on show up under "Found on your network" (they advertise Valve's devkit service over mDNS); click one, or type a hostname or IP. Click **Pair with headset**. Open Settings → Developer → **Pair new host** on the headset and approve.
3. Drop a file. Check the name, pick a runtime if there's a choice, click **Install to Frame**.

Logs for Android titles stream straight into the app (row → Logs). The Activity drawer at the bottom shows every command sent to the headset.

## Development

This is a pnpm workspace:

| Path | What it is |
|---|---|
| `apps/desktop` | The Electron app (TypeScript, esbuild, electron-builder) |
| `apps/web` | The website (plain HTML and CSS, built with Vite) |
| `packages/tokens` | Shared color, type and shape tokens used by both |

```bash
pnpm install
pnpm start          # build and run the desktop app
pnpm dev:web        # website dev server on http://localhost:5180
pnpm typecheck
pnpm test
pnpm build:web      # static site in apps/web/dist
pnpm dist:mac       # or dist:win / dist:linux
```

The desktop app bundles all of its runtime dependencies into `dist/main.cjs`, so packages contain no `node_modules`.

The renderer can be previewed in a normal browser with simulated data: serve `apps/desktop/dist/` and open `index.html?mock=connected` (also `fresh`, `empty`, `offline`, `nolepton`, `fail`). `pnpm --filter @frameloader/desktop screenshots` regenerates the website's screenshots from that mock, in light and dark.

`pnpm install` must be allowed to run the `electron` and `esbuild` build scripts (see `pnpm-workspace.yaml`). If Electron's binary is missing, run `node node_modules/electron/install.js`.

## Privacy

Frameloader has no analytics, telemetry, crash reporting, accounts or update checks. Its only network connections are to your headset on your local network: SSH, Valve's devkit pairing service on port 32000, and mDNS discovery. A remembered password is encrypted with the operating system's secure storage. The website loads no third-party scripts, fonts or cookies.

## Troubleshooting

- **"Couldn't find frame.local."** Frameloader resolves names itself over mDNS, then the OS resolver, then by browsing for the devkit service, then the last known IP. If all fail: the Frame is asleep (it drops off the network), Developer Mode is off, or the network blocks multicast (guest/isolated Wi-Fi). Typing the IP from Quick Settings always works.
- **Pairing says the headset didn't answer.** Steam must be sitting on the Pair new host screen while Frameloader asks.
- **"Steam isn't running on the headset."** Registration needs the Steam client up; put the headset on or wake it and try again.
- **A 2D Android app launches but nothing shows.** Reinstall with "Show a 2D window" on (Advanced).
- **Lepton missing.** Click Install next to the Lepton chip (it asks Steam to install app 3056000); confirm on the headset.
- **Compat tool alias.** Valve's current scripts expect `lepton`. If your firmware wants a different name (older builds used `fauxdroid`), add `"compatToolOverrides": {"lepton": "lepton-stable"}` to Frameloader's `config.json` in its user-data folder.

## Credits

- Valve's [SteamOS Devkit Client](https://gitlab.steamos.cloud/devkit/steamos-devkit) (MIT) for the device-side scripts and the protocol.
- [Lepton](https://gitlab.steamos.cloud/frame-public/lepton) (MIT) for documenting how Android titles are launched.
- [Frame Control](https://github.com/saphid/frame-control) (MIT) for field notes that verified each runtime on real hardware.

MIT licensed. If Frameloader saves you some time, you can [buy me a coffee](https://buymeacoffee.com/travelerdev).
