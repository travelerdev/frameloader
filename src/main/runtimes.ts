import type { DeviceInfo, PayloadInfo, PayloadKind, RuntimeId, RuntimeOption } from "../shared/ipc";

interface RuntimeDef {
  label: string;
  compatTool: string;
  settings: Record<string, string>;
  note?: string;
  kinds: PayloadKind[];
}

export const RUNTIMES: Record<RuntimeId, RuntimeDef> = {
  lepton: { label: "Lepton (Android)", compatTool: "lepton", settings: { steam_play: "0" }, kinds: ["apk"] },
  "proton-experimental": {
    label: "Proton Experimental",
    compatTool: "proton-experimental",
    settings: { steam_play: "1", steam_play_debug: "0", steam_play_debug_version: "2019" },
    kinds: ["windows"],
  },
  "proton-stable": {
    label: "Proton (stable)",
    compatTool: "proton-stable",
    settings: { steam_play: "1", steam_play_debug: "0", steam_play_debug_version: "2019" },
    kinds: ["windows"],
  },
  "slr4-arm64": {
    label: "Steam Linux Runtime 4 (ARM64)",
    compatTool: "SteamLinuxRuntime_4-arm64",
    settings: { steam_play: "0" },
    note: "Starts natively; self-contained builds only.",
    kinds: ["linux-arm64"],
  },
  "slr4-x64": {
    label: "Steam Linux Runtime 4 (x86-64)",
    compatTool: "SteamLinuxRuntime_4",
    settings: { steam_play: "0" },
    note: "The Frame doesn't install this runtime for sideloaded titles.",
    kinds: ["linux-x64"],
  },
};

export function defaultRuntime(kind: PayloadKind): RuntimeId | undefined {
  switch (kind) {
    case "apk":
      return "lepton";
    case "windows":
      return "proton-experimental";
    case "linux-arm64":
      return "slr4-arm64";
    case "linux-x64":
      return "slr4-x64";
    default:
      return undefined;
  }
}

export function runtimeFromCompatTool(tool: string | undefined): RuntimeId | undefined {
  if (!tool) return undefined;
  const t = tool.toLowerCase();
  if (t === "lepton" || t === "fauxdroid" || t.startsWith("lepton")) return "lepton";
  if (t === "proton-experimental") return "proton-experimental";
  if (t.startsWith("proton")) return "proton-stable";
  if (t === "steamlinuxruntime_4-arm64") return "slr4-arm64";
  if (t === "steamlinuxruntime_4") return "slr4-x64";
  return undefined;
}

export function settingsFor(id: RuntimeId, overrides: Record<string, string> = {}): Record<string, string> {
  const def = RUNTIMES[id];
  return { ...def.settings, compat_tool: overrides[def.compatTool] ?? overrides[id] ?? def.compatTool };
}

export function runtimeOptions(payload: PayloadInfo, info: DeviceInfo | undefined, overrides: Record<string, string> = {}): RuntimeOption[] {
  const out: RuntimeOption[] = [];
  for (const [id, def] of Object.entries(RUNTIMES) as [RuntimeId, RuntimeDef][]) {
    if (!def.kinds.includes(payload.kind)) continue;
    let available = true;
    let unavailableReason: string | undefined;
    if (id === "lepton" && info && !info.leptonInstalled) {
      available = false;
      unavailableReason = "Lepton isn't installed on the headset yet.";
    }
    if ((id === "proton-experimental" || id === "proton-stable") && info && info.protonInstalled.length === 0) {
      available = false;
      unavailableReason = "No Proton is installed on the headset. Install any Windows game, or Proton from Steam's compatibility tools, first.";
    }
    if (id === "slr4-x64") {
      available = false;
      unavailableReason = def.note;
    }
    out.push({ id, label: def.label, compatTool: settingsFor(id, overrides).compat_tool ?? def.compatTool, note: def.note, available, unavailableReason });
  }
  return out;
}
