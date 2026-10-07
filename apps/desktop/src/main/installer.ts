// The install flow: prepare folder, upload, register with Steam, launch.
import { statSync } from "node:fs";
import { basename, posix } from "node:path";
import type { InstallProgress, InstallRequest, InstallResult, InstallStep } from "../shared/ipc";
import { activity } from "./activity";
import { config } from "./config";
import { createShortcut, prepareUpload, runGame, syncDevkitUtils, type ShortcutParms, type TitleMeta } from "./devkitUtils";
import { friendlyError } from "./errors";
import { getPayload } from "./payload";
import { RUNTIMES, settingsFor } from "./runtimes";
import { session } from "./session";
import { shq } from "./ssh";
import { renameDevkitTitle } from "./steamClient";
import { gameIdProblem } from "../shared/gameid";

export type ProgressSink = (p: InstallProgress) => void;

function safeApkName(path: string): string {
  const b = basename(path).replace(/[^A-Za-z0-9._-]+/g, "_");
  return /\.apk$/i.test(b) && b.length > 4 ? b : "app.apk";
}

/** Split "a b 'c d'" into argv the way a shell would, loosely. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export async function install(req: InstallRequest, progress: ProgressSink): Promise<InstallResult> {
  const steps: InstallStep[] = ["prepare", "upload", "register", "launch"];
  const status = new Map<InstallStep, InstallProgress>(steps.map((s) => [s, { step: s, status: "pending" }]));
  const set = (step: InstallStep, p: Partial<InstallProgress>) => {
    const next = { ...status.get(step)!, ...p };
    status.set(step, next);
    progress(next);
  };
  let current: InstallStep = "prepare";
  try {
    const payload = getPayload(req.payloadId);
    if (!payload) throw new Error("That file isn't available anymore. Drop it again.");
    const problem = gameIdProblem(req.gameId);
    if (problem) throw new Error(`Library ID: ${problem}`);
    if (payload.info.issues.length) throw new Error(payload.info.issues[0]);
    const runtime = RUNTIMES[req.runtime];
    if (!runtime.kinds.includes(payload.info.kind)) throw new Error(`${runtime.label} can't run this kind of app.`);
    const ssh = session.require();
    const info = session.requireInfo();
    if (req.runtime === "lepton" && !info.leptonInstalled) throw new Error("Lepton isn't installed on the headset yet. Install it from the device menu, confirm on the headset, then try again.");
    if ((req.runtime === "proton-experimental" || req.runtime === "proton-stable") && !info.protonInstalled.length) throw new Error("No Proton is installed on the headset yet.");
    if (req.runtime === "slr4-x64") throw new Error("The Frame can't run 64-bit x86 Linux builds as sideloaded titles.");

    // 1. prepare
    set("prepare", { status: "active", detail: "Preparing a folder on the headset" });
    await syncDevkitUtils(ssh, info.home);
    const { directory } = await prepareUpload(ssh, info.home, req.gameId);
    if (!directory.startsWith(info.home) || !directory.endsWith("/" + req.gameId)) throw new Error(`The headset returned an unexpected folder: ${directory}`);
    await ssh.exec(`find ${shq(directory)} -mindepth 1 -delete`, { quiet: true });
    set("prepare", { status: "done", detail: directory });

    // 2. upload
    current = "upload";
    set("upload", { status: "active", detail: "Uploading", bytes: 0, total: payload.info.sizeBytes });
    let argv: string[];
    let flatscreen = false;
    const meta: TitleMeta = { name: req.name.trim() || req.gameId, kind: payload.info.kind, installedAt: new Date().toISOString(), sizeBytes: payload.info.sizeBytes };
    if (payload.info.kind === "apk" && payload.apkPath && payload.info.apk) {
      const apkName = safeApkName(payload.apkPath);
      const remoteApk = posix.join(directory, apkName);
      const total = payload.info.sizeBytes;
      let done = 0;
      await ssh.putFile(payload.apkPath, remoteApk + ".part", {
        mode: 0o755,
        onProgress: (sent) => set("upload", { status: "active", bytes: done + sent, total }),
      });
      done += statSync(payload.apkPath).size;
      await ssh.exec(`mv -f ${shq(remoteApk + ".part")} ${shq(remoteApk)}`, { quiet: true });
      if (payload.obbPaths.length) {
        await ssh.exec(`mkdir -p ${shq(posix.join(directory, "obb"))}`, { quiet: true });
        for (const obb of payload.obbPaths) {
          const name = basename(obb).replace(/[^A-Za-z0-9._-]+/g, "_");
          await ssh.putFile(obb, posix.join(directory, "obb", name), {
            mode: 0o644,
            onProgress: (sent) => set("upload", { status: "active", bytes: done + sent, total }),
          });
          done += statSync(obb).size;
        }
      }
      flatscreen = req.flatscreen;
      if (flatscreen) await ssh.exec(`touch ${shq(posix.join(directory, "lepton-show-flatscreen"))}`, { quiet: true });
      argv = [apkName];
      meta.apkPackage = payload.info.apk.package;
      meta.versionName = payload.info.apk.versionName;
      meta.isVr = payload.info.apk.isVr;
      meta.flatscreen = flatscreen;
    } else if (payload.rootDir) {
      const start = (req.startCommand ?? payload.info.candidates?.[0]?.relPath ?? "").trim();
      if (!start) throw new Error("Pick the executable to start.");
      await ssh.putDir(payload.rootDir, directory, {
        onProgress: (sent, total) => set("upload", { status: "active", bytes: sent, total }),
      });
      argv = [/\s/.test(start) ? `"${start}"` : start, ...splitArgs(req.launchArgs)];
      meta.startCommand = start;
    } else {
      throw new Error("Nothing to upload.");
    }
    await ssh.writeFile(posix.join(directory, ".frameloader.json"), JSON.stringify(meta, null, 2) + "\n");
    await ssh.exec(`chmod -R u+rwX,go+rX ${shq(directory)}`, { quiet: true });
    set("upload", { status: "done", detail: "Uploaded", bytes: payload.info.sizeBytes, total: payload.info.sizeBytes });

    // 3. register
    current = "register";
    set("register", { status: "active", detail: "Registering with Steam" });
    const overrides = { ...config.compatToolOverrides(), ...(session.device?.compatToolOverrides ?? {}) };
    const parms: ShortcutParms = {
      gameid: req.gameId,
      directory,
      argv,
      env: req.env,
      settings: settingsFor(req.runtime, overrides),
      clear_settings: true,
      force_appid: "",
      lepton_args: req.runtime === "lepton" ? req.launchArgs.trim() : "",
    };
    const reply = await createShortcut(ssh, info.home, parms);
    activity.info(`Steam registered "${req.gameId}"${reply ? `: ${reply}` : ""}`);
    set("register", { status: "active", detail: "Setting the library name" });
    const renamed = await renameDevkitTitle(ssh, req.gameId, directory, meta.name);
    set("register", { status: "done", detail: renamed ? "In your library under Non-Steam" : `In your library under Non-Steam as “Devkit Game: ${req.gameId}”` });

    // 4. launch
    current = "launch";
    if (req.launchAfter) {
      set("launch", { status: "active", detail: "Launching on the headset" });
      await runGame(ssh, info.home, req.gameId);
      set("launch", { status: "done", detail: "Launched" });
    } else {
      set("launch", { status: "skipped" });
    }
    return { ok: true, gameId: req.gameId, name: meta.name };
  } catch (e) {
    const message = friendlyError(e, session.device?.host ?? "the headset");
    set(current, { status: "failed", detail: message });
    for (const s of steps.slice(steps.indexOf(current) + 1)) set(s, { status: "skipped" });
    activity.push("err", `Install failed: ${message}`);
    return { ok: false, gameId: req.gameId, name: req.name, error: message };
  }
}
