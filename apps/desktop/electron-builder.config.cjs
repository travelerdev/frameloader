// electron-builder config. Pass with: electron-builder --config electron-builder.config.cjs
//
// macOS signing depends on the environment:
// - Release builds (the release-signing GitHub environment) set CSC_LINK, so the app is
//   signed with the Developer ID certificate, uses the hardened runtime, and is notarized
//   with the App Store Connect key (APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER).
// - Everything else (local builds, pushes, pull requests) is ad-hoc signed.
const signed = Boolean(process.env.CSC_LINK);

const base = {
  "appId": "dev.traveler.frameloader",
  "productName": "Frameloader",
  "directories": {
    "output": "release",
    "buildResources": "build"
  },
  "files": [
    "dist/**/*",
    "package.json",
    "!dist/test/**",
    "!dist/**/*.map"
  ],
  "extraResources": [
    {
      "from": "vendor/devkit-utils",
      "to": "devkit-utils",
      "filter": [
        "**/*",
        "!**/__pycache__/**"
      ]
    }
  ],
  "mac": {
    "category": "public.app-category.utilities",
    "target": [
      "dmg",
      "zip"
    ],
    "artifactName": "Frameloader-mac-${arch}.${ext}",
    "extendInfo": {
      "NSLocalNetworkUsageDescription": "Frameloader connects to your Steam Frame on your local network to install and launch apps.",
      "NSBonjourServices": [
        "_steamos-devkit._tcp",
        "_ssh._tcp"
      ]
    }
  },
  "win": {
    "target": [
      "nsis",
      "zip"
    ],
    "artifactName": "Frameloader-win-${arch}.${ext}"
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true
  },
  "linux": {
    "target": [
      "AppImage",
      "deb"
    ],
    "category": "Utility",
    "artifactName": "Frameloader-linux-${arch}.${ext}",
    "executableName": "frameloader"
  },
  "electronVersion": "44.5.1"
};

module.exports = {
  ...base,
  mac: {
    ...base.mac,
    ...(signed
      ? {
          hardenedRuntime: true,
          entitlements: "build/entitlements.mac.plist",
          entitlementsInherit: "build/entitlements.mac.plist",
          notarize: true,
        }
      : { identity: "-", hardenedRuntime: false }),
  },
};
