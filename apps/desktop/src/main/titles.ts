import { posix } from "node:path";
import type { PayloadKind, TitleInfo } from "../shared/ipc";
import { deleteTitle, listTitles, runGame, type RawTitle } from "./devkitUtils";
import { LEPTON_PATH } from "./preflight";
import { runtimeFromCompatTool } from "./runtimes";
import { shq, type SshSession } from "./ssh";

export function toTitleInfo(raw: RawTitle): TitleInfo {
  const compatTool = raw.settings?.compat_tool;
  const runtime = runtimeFromCompatTool(compatTool);
  const metaKind = raw.meta.kind as PayloadKind | undefined;
  const kind: PayloadKind = metaKind ?? (raw.apks.length || runtime === "lepton" ? "apk" : runtime === "proton-experimental" || runtime === "proton-stable" ? "windows" : runtime === "slr4-arm64" ? "linux-arm64" : runtime === "slr4-x64" ? "linux-x64" : "unknown");
  return {
    gameId: raw.gameId,
    name: raw.meta.name || raw.gameId,
    directory: raw.directory,
    kind,
    runtime,
    compatTool,
    argv: raw.argv ?? undefined,
    installedAt: raw.meta.installedAt,
    apkPackage: raw.meta.apkPackage,
    versionName: raw.meta.versionName,
    isVr: raw.meta.isVr,
    flatscreen: raw.flatscreen,
    sizeBytes: raw.sizeBytes,
  };
}

export async function getTitles(ssh: SshSession): Promise<TitleInfo[]> {
  const raw = await listTitles(ssh);
  return raw.map(toTitleInfo).sort((a, b) => (b.installedAt ?? "").localeCompare(a.installedAt ?? "") || a.name.localeCompare(b.name));
}

export async function launchTitle(ssh: SshSession, home: string, gameId: string): Promise<void> {
  await runGame(ssh, home, gameId);
}

/** Find the Lepton instance running a package, e.g. "steamlaunch-123" from `lepton ps`. */
export async function leptonInstanceFor(ssh: SshSession, apkPackage: string | undefined, directory: string): Promise<string | undefined> {
  const r = await ssh.exec(`if [ -x "${LEPTON_PATH}" ]; then TERM=dumb "${LEPTON_PATH}" ps 2>/dev/null; fi`, { quiet: true });
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^(\S+)\s*\((.*)\)\s*$/);
    if (!m) continue;
    const [, instance, rest] = m;
    if (apkPackage && rest!.includes(apkPackage)) return instance;
    if (rest!.includes(posix.basename(directory))) return instance;
  }
  return undefined;
}

export async function stopTitle(ssh: SshSession, title: TitleInfo): Promise<void> {
  if (title.kind === "apk") {
    const instance = await leptonInstanceFor(ssh, title.apkPackage, title.directory);
    if (instance) {
      await ssh.exec(`TERM=dumb "${LEPTON_PATH}" kill ${shq(instance)} >/dev/null 2>&1 || true`);
    }
  }
  await ssh.exec(`pkill -TERM -f ${shq(title.directory + "/")} >/dev/null 2>&1 || true`, { quiet: true });
}

export async function removeTitle(ssh: SshSession, home: string, title: TitleInfo): Promise<void> {
  await stopTitle(ssh, title).catch(() => undefined);
  await deleteTitle(ssh, home, title.gameId);
}
