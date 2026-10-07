// What's on the headset: build, Steam running, Lepton and Proton present.
import type { DeviceInfo } from "../shared/ipc";
import type { SshSession } from "./ssh";

export const LEPTON_PATH = "$HOME/.local/share/Steam/steamapps/common/Lepton/lepton";
export const LEPTON_APPID = 3056000;

const SCRIPT = [
  "echo '---OS'; cat /etc/os-release 2>/dev/null",
  "echo '---HOME'; echo \"$HOME\"",
  "echo '---STEAM'; if [ -f \"$HOME/.steam/steam.pid\" ] && kill -0 \"$(cat \"$HOME/.steam/steam.pid\")\" 2>/dev/null; then echo running; else echo stopped; fi",
  `echo '---LEPTON'; if [ -x "${LEPTON_PATH}" ]; then echo yes; else echo no; fi`,
  "echo '---COMMON'; ls -1 \"$HOME/.local/share/Steam/steamapps/common\" 2>/dev/null",
  "echo '---END'",
].join("; ");

function section(text: string, name: string): string {
  const m = text.match(new RegExp(`---${name}\\n([\\s\\S]*?)(?=\\n---|$)`));
  return m?.[1]?.trim() ?? "";
}

export async function preflight(ssh: SshSession): Promise<DeviceInfo> {
  const r = await ssh.exec(SCRIPT, { quiet: true });
  const out = r.stdout;
  const os = section(out, "OS");
  const kv = (k: string) => os.match(new RegExp(`^${k}=\"?([^\"\\n]*)\"?$`, "m"))?.[1];
  const commonDirs = section(out, "COMMON").split("\n").map((s) => s.trim()).filter(Boolean);
  const info: DeviceInfo = {
    host: ssh.host,
    home: section(out, "HOME") || `/home/${ssh.username}`,
    buildId: kv("BUILD_ID"),
    versionId: kv("VERSION_ID"),
    variantId: kv("VARIANT_ID"),
    isFrame: kv("VARIANT_ID") === "vr",
    steamRunning: section(out, "STEAM") === "running",
    leptonInstalled: section(out, "LEPTON") === "yes",
    protonInstalled: commonDirs.filter((d) => /proton/i.test(d)),
    commonDirs,
  };
  return info;
}

export async function requestLeptonInstall(ssh: SshSession): Promise<void> {
  await ssh.exec(`steam steam://install/${LEPTON_APPID} >/dev/null 2>&1 || true`);
}
