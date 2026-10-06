import { formatBytes, timeAgo } from "../../shared/format";
import type { TitleInfo } from "../../shared/ipc";
import { h, icon, kindIcon } from "../dom";
import { store, type State } from "../state";
import { disconnect, installLepton, launchTitle, openPanel, pickFiles, refreshTitles, removeTitle, retryConnection } from "../actions";
import { reviewView } from "./review";
import { installView } from "./install";

export function topbar(s: State): HTMLElement {
  const c = s.connection;
  const info = c.info;
  const device = s.devices.find((d) => d.id === c.deviceId);
  const online = c.status === "connected";
  const chipLabel = device?.nickname ?? c.host ?? "No headset";
  const sub = info ? `${c.address ?? ""}${c.address ? " · " : ""}SteamOS ${info.versionId ?? "?"}` : c.status === "offline" ? "offline" : "";
  const runtimeChips = info
    ? h(
        "div",
        { class: "runtimes" },
        info.leptonInstalled
          ? h("span", { class: "chip ok" }, "Lepton ✓")
          : h("span", { class: "chip dashed" }, "Lepton missing ", h("button", { class: "link", disabled: s.busy.has("lepton"), onclick: () => void installLepton() }, "Install")),
        info.protonInstalled.length ? h("span", { class: "chip ok" }, "Proton ✓") : h("span", { class: "chip dashed", title: "Install any Windows game on the headset to get Proton." }, "Proton missing"),
      )
    : null;
  const menu = s.menuOpen
    ? h(
        "div",
        { class: "menu", "data-anim": "device-menu" },
        s.devices.length > 1 ? h("div", { class: "label" }, "Switch headset") : null,
        ...s.devices.filter((d) => d.id !== c.deviceId).map((d) => h("button", { onclick: () => void import("../actions").then((a) => a.connectSaved(d.id)) }, icon("headset"), d.nickname)),
        s.devices.length > 1 ? h("div", { class: "sep" }) : null,
        h("button", { onclick: () => store.set({ devicesSheet: true, menuOpen: false }) }, icon("plus"), "Manage headsets"),
        h("button", { onclick: () => void refreshTitles() }, icon("refresh"), "Refresh"),
        h("div", { class: "sep" }),
        h("button", { class: "danger", onclick: () => void disconnect() }, icon("logout"), "Disconnect"),
      )
    : null;
  return h(
    "div",
    { class: "topbar" },
    h("div", { class: "brand" }, h("span", { class: "logo" }, icon("drop")), "Frameloader"),
    h(
      "div",
      { class: "device-chip" },
      h(
        "button",
        { class: "btn sm", onclick: (e: Event) => { e.stopPropagation(); store.set({ menuOpen: !s.menuOpen }); } },
        h("span", { class: "dot", style: `width:8px;height:8px;border-radius:50%;background:${online ? "var(--success)" : "var(--text-3)"}` }),
        chipLabel,
        sub ? h("span", { class: "muted small" }, "· " + sub) : null,
        icon("chevron", ""),
      ),
      runtimeChips,
      menu,
    ),
  );
}

export function homeView(s: State): HTMLElement {
  const offline = s.connection.status !== "connected";
  const banner = offline
    ? h(
        "div",
        { class: "banner" },
        icon("info"),
        h("div", { class: "grow" }, h("b", {}, `${s.connection.host ?? "The headset"} is ${s.connection.status === "connecting" ? "reconnecting" : "offline"}.`), " ", h("span", { class: "muted" }, s.connection.message ?? "The Frame leaves the network while asleep.")),
        s.connection.status === "connecting" ? h("span", { class: "spinner" }) : h("button", { class: "btn sm", onclick: () => void retryConnection() }, icon("refresh"), "Retry"),
      )
    : null;

  let hero: HTMLElement;
  if (s.install) hero = installView(s);
  else if (s.payload && s.review) hero = reviewView(s);
  else hero = dropzone(s);

  const titles = h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("div", { class: "row" }, h("h3", {}, "On your Frame"), s.titlesLoaded ? h("span", { class: "chip" }, String(s.titles.length)) : null),
      h("button", { class: "btn quiet sm", disabled: offline || s.busy.has("titles"), onclick: () => void refreshTitles() }, s.busy.has("titles") ? h("span", { class: "spinner" }) : icon("refresh"), "Refresh"),
    ),
    h(
      "div",
      { class: "titles" },
      s.titles.length
        ? s.titles.map((t) => titleRow(s, t, offline))
        : h("div", { class: "empty" }, s.titlesLoaded ? "Nothing sideloaded yet. Drop something above." : offline ? "Connect to see what's installed." : "Looking…"),
    ),
  );

  return h("div", { class: "main", onclick: () => { if (s.menuOpen || s.rowMenu) store.set({ menuOpen: false, rowMenu: undefined }); } }, h("div", { class: "container" }, banner, hero, titles));
}

function dropzone(s: State): HTMLElement {
  const offline = s.connection.status !== "connected";
  return h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "dropzone" + (s.dragOver ? " over" : ""), id: "dropzone" },
      s.inspecting ? h("span", { class: "spinner", style: "width:28px;height:28px" }) : icon("upload"),
      h("div", { class: "big" }, s.dragOver ? "Release to inspect" : s.inspecting ? "Reading the app…" : "Drop an APK, Windows app, zip, or folder"),
      h("div", { class: "muted" }, "It gets copied to the headset and added to your Steam library."),
      h("button", { class: "btn", disabled: s.inspecting, onclick: () => void pickFiles() }, "Choose file…"),
    ),
    s.inspectError ? h("div", { class: "notice bad" }, s.inspectError) : null,
    offline && !s.inspectError ? h("div", { class: "help", style: "text-align:center" }, "You can inspect files while offline; installing needs the headset.") : null,
  );
}

function titleRow(s: State, t: TitleInfo, offline: boolean): HTMLElement {
  const kindLabel = t.kind === "apk" ? "Android" : t.kind === "windows" ? "Windows" : t.kind === "linux-arm64" ? "Linux ARM64" : t.kind === "linux-x64" ? "Linux x86-64" : "App";
  const runtimeLabel = t.runtime === "lepton" ? "Lepton" : t.runtime === "proton-experimental" ? "Proton Experimental" : t.runtime === "proton-stable" ? "Proton" : t.runtime === "slr4-arm64" ? "Linux ARM64" : t.runtime === "slr4-x64" ? "Linux x86-64" : t.compatTool ?? "Native";
  const bits = [kindLabel, t.kind === "apk" ? (t.isVr ? "VR app" : "2D app") : null, t.versionName ? `v${t.versionName}` : null, t.installedAt ? `installed ${timeAgo(t.installedAt)}` : null, t.sizeBytes ? formatBytes(t.sizeBytes) : null].filter(Boolean);
  const menuOpen = s.rowMenu === t.gameId;
  return h(
    "div",
    { class: "title-row" },
    h("div", { class: "icon" }, kindIcon(t.kind)),
    h("div", { class: "grow", style: "cursor: pointer", onclick: () => openPanel(t.gameId) }, h("div", { class: "name" }, t.name), h("div", { class: "meta" }, bits.join(" · "))),
    h("span", { class: "chip" }, runtimeLabel),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn sm", disabled: offline || s.busy.has(`launch:${t.gameId}`), onclick: () => void launchTitle(t.gameId) }, s.busy.has(`launch:${t.gameId}`) ? h("span", { class: "spinner" }) : icon("play"), "Play"),
      t.kind === "apk" ? h("button", { class: "btn sm quiet", disabled: offline, onclick: () => openPanel(t.gameId, "logs") }, icon("terminal"), "Logs") : null,
      h("button", { class: "btn sm quiet", "aria-label": "More", onclick: (e: Event) => { e.stopPropagation(); store.set({ rowMenu: menuOpen ? undefined : t.gameId, menuOpen: false }); } }, icon("more")),
      menuOpen
        ? h(
            "div",
            { class: "menu", "data-anim": `row-menu-${t.gameId}` },
            h("button", { onclick: () => openPanel(t.gameId) }, icon("info"), "Details"),
            h("button", { disabled: offline, onclick: () => void import("../actions").then((a) => a.stopTitle(t.gameId)) }, icon("stop"), "Stop"),
            h("div", { class: "sep" }),
            h("button", { class: "danger", disabled: offline, onclick: () => { store.set({ rowMenu: undefined }); openPanel(t.gameId); setTimeout(() => import("../actions").then((a) => a.setPanel({ confirmRemove: true })), 0); } }, icon("trash"), "Remove…"),
          )
        : null,
    ),
  );
}

export { removeTitle };
