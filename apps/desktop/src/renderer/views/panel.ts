import { formatBytes, timeAgo } from "../../shared/format";
import { h, icon, kindIcon } from "../dom";
import type { State } from "../state";
import { closePanel, launchTitle, logPane, removeTitle, setPanel, startLogs, stopLogs, stopTitle } from "../actions";

export function panelView(s: State): HTMLElement[] {
  const p = s.panel!;
  const t = s.titles.find((x) => x.gameId === p.gameId);
  if (!t) {
    closePanel();
    return [];
  }
  const offline = s.connection.status !== "connected";
  const head = h(
    "div",
    { class: "card-head" },
    h("div", { class: "row" }, h("div", { class: "icon", style: "width:32px;height:32px;border-radius:8px;display:grid;place-items:center;background:var(--card-2);border:1px solid var(--border)" }, kindIcon(t.kind)), h("h3", {}, t.name)),
    h("button", { class: "btn quiet sm", "aria-label": "Close", onclick: () => closePanel() }, icon("x")),
  );
  const tabs = h(
    "div",
    { class: "tabs" },
    h("button", { class: p.tab === "details" ? "on" : "", onclick: () => setPanel({ tab: "details" }) }, "Details"),
    t.kind === "apk" && s.settings.developerTools ? h("button", { class: p.tab === "logs" ? "on" : "", onclick: () => (p.streaming || logPane.count ? setPanel({ tab: "logs" }) : void startLogs()) }, "Logs") : null,
  );

  let body: HTMLElement;
  if (p.tab === "logs" && s.settings.developerTools) {
    body = h(
      "div",
      { class: "panel-body" },
      h(
        "div",
        { class: "row" },
        h("input", {
          id: "logfilter",
          class: "input grow",
          placeholder: "Filter",
          value: p.filter,
          oninput: (e: Event) => {
            const filter = (e.target as HTMLInputElement).value;
            logPane.setFilter(filter);
            setPanel({ filter });
          },
        }),
        p.streaming
          ? h("button", { class: "btn sm", onclick: () => { logPane.setPaused(!p.paused); setPanel({ paused: !p.paused }); } }, icon(p.paused ? "play" : "pause"), p.paused ? "Resume" : "Pause")
          : h("button", { class: "btn sm", disabled: offline, onclick: () => void startLogs() }, icon("play"), "Start"),
        h("button", { class: "btn sm quiet", onclick: () => logPane.clear() }, icon("eraser"), "Clear"),
        h("button", { class: "btn sm quiet", onclick: () => void navigator.clipboard.writeText(logPane.text()) }, icon("copy"), "Copy"),
        p.streaming ? h("button", { class: "btn sm quiet", onclick: () => void stopLogs() }, icon("stop"), "Stop") : null,
      ),
      p.error ? h("div", { class: "notice bad" }, p.error) : null,
      logPane.el,
    );
  } else {
    const runtimeLabel = t.runtime === "lepton" ? "Lepton (Android)" : t.runtime === "proton-experimental" ? "Proton Experimental" : t.runtime === "proton-stable" ? "Proton (stable)" : t.runtime === "slr4-arm64" ? "Steam Linux Runtime 4 (ARM64)" : t.compatTool ?? "Native";
    body = h(
      "div",
      { class: "panel-body" },
      h(
        "dl",
        { class: "dl" },
        h("dt", {}, "Runtime"), h("dd", {}, runtimeLabel),
        h("dt", {}, "Library ID"), h("dd", { class: "mono" }, t.gameId),
        t.apkPackage ? h("dt", {}, "Package") : null, t.apkPackage ? h("dd", { class: "mono" }, t.apkPackage) : null,
        t.versionName ? h("dt", {}, "Version") : null, t.versionName ? h("dd", {}, t.versionName) : null,
        t.kind === "apk" ? h("dt", {}, "Window") : null, t.kind === "apk" ? h("dd", {}, t.flatscreen ? "2D window shown" : "VR / hidden window") : null,
        h("dt", {}, "Installed"), h("dd", {}, t.installedAt ? `${timeAgo(t.installedAt)} (${new Date(t.installedAt).toLocaleString()})` : "unknown"),
        h("dt", {}, "Size"), h("dd", {}, t.sizeBytes ? formatBytes(t.sizeBytes) : "unknown"),
        h("dt", {}, "On the headset"), h("dd", { class: "mono" }, t.directory),
        t.argv?.length ? h("dt", {}, "Start command") : null, t.argv?.length ? h("dd", { class: "mono" }, t.argv.join(" ")) : null,
      ),
      h(
        "div",
        { class: "row wrap" },
        h("button", { class: "btn primary", disabled: offline || s.busy.has(`launch:${t.gameId}`), onclick: () => void launchTitle(t.gameId) }, icon("play"), "Play"),
        h("button", { class: "btn", disabled: offline || s.busy.has(`stop:${t.gameId}`), onclick: () => void stopTitle(t.gameId) }, icon("stop"), "Stop"),
        h("button", { class: "btn danger", disabled: offline, onclick: () => setPanel({ confirmRemove: true }) }, icon("trash"), "Remove"),
      ),
      p.confirmRemove
        ? h(
            "div",
            { class: "notice bad stack" },
            h("div", {}, h("b", {}, `Remove ${t.name} from your Frame?`), " Its files and save data are deleted."),
            h("div", { class: "row" }, h("button", { class: "btn danger", disabled: s.busy.has(`remove:${t.gameId}`), onclick: () => void removeTitle(t.gameId) }, s.busy.has(`remove:${t.gameId}`) ? h("span", { class: "spinner" }) : icon("trash"), "Remove"), h("button", { class: "btn", onclick: () => setPanel({ confirmRemove: false }) }, "Keep")),
          )
        : null,
      h("p", { class: "help" }, "Steam shows this title under Library → Non-Steam as “Devkit Game: " + t.gameId + "”."),
    );
  }
  return [h("div", { class: "overlay", "data-anim": "panel-overlay", onclick: () => closePanel() }), h("div", { class: "panel", "data-anim": "panel" }, head, tabs, body)];
}
