# Valve's devkit-utils (vendored, unmodified)

Device-side helper scripts from Valve's SteamOS Devkit Client
(https://gitlab.steamos.cloud/devkit/steamos-devkit), release v0.20260925.1,
MIT licensed (see LICENSE). Frameloader copies this folder to `~/devkit-utils`
on the headset, the same place Valve's own client puts it, and drives
`steamos-prepare-upload`, `steam-client-create-shortcut`, `steam-devkit-rpc`,
`steamos-list-games` and `steamos-delete` over SSH to register sideloaded
titles as Steam "Devkit Games".

Do not edit these files. To update, copy a newer `client/devkit-utils/` over
this folder and bump the version above.
