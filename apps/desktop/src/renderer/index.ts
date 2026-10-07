import { consumeScrollTop, h, withFocusRestore } from "./dom";
import { api, isMock } from "./api";
import { store, type State } from "./state";
import { bootstrap, closePanel, closeSettings, inspectPaths, startDiscovery, stopDiscovery } from "./actions";
import { connectView } from "./views/connect";
import { homeView, topbar } from "./views/home";
import { panelView } from "./views/panel";
import { devicesView } from "./views/devices";
import { drawerView } from "./views/drawer";
import { settingsView, updateBanner } from "./views/settings";

const root = document.getElementById("app")!;
if (navigator.platform.toLowerCase().includes("mac")) document.body.classList.add("mac");

function showConnect(s: State): boolean {
  const c = s.connection;
  if (c.status === "connected") return false;
  if (c.status === "pairing" || c.status === "connecting") return !c.deviceId || !s.devices.length;
  if (c.status === "offline") return false;
  return true;
}

function render(s: State): void {
  const mounted = new Set(Array.from(root.querySelectorAll<HTMLElement>("[data-anim]")).map((el) => el.dataset.anim!));
  withFocusRestore(root, () => {
    root.replaceChildren();
    root.appendChild(h("div", { class: "titlebar-drag" }));
    const banner = updateBanner(s);
    if (showConnect(s)) {
      if (banner) root.appendChild(banner);
      root.appendChild(connectView(s));
      if (s.connection.status === "disconnected") startDiscovery();
      else stopDiscovery();
    } else {
      stopDiscovery();
      root.appendChild(topbar(s));
      if (banner) root.appendChild(banner);
      root.appendChild(homeView(s));
      if (s.settings.developerTools) root.appendChild(drawerView(s));
    }
    if (s.panel) for (const el of panelView(s)) root.appendChild(el);
    if (s.devicesSheet) for (const el of devicesView(s)) root.appendChild(el);
    if (s.settingsOpen) for (const el of settingsView(s)) root.appendChild(el);
    if (s.toast) root.appendChild(h("div", { class: `notice ${s.toast.kind}`, "data-anim": "toast", style: "position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:40;box-shadow:0 8px 24px rgba(16,24,40,.15);max-width:min(560px,90vw)" }, s.toast.text));
    if (isMock && !new URLSearchParams(location.search).has("shot")) root.appendChild(h("div", { class: "chip warn", style: "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:50" }, "Preview mode: no headset, simulated data"));
    // Entrance animations only when an element first appears, not on every re-render.
    root.querySelectorAll<HTMLElement>("[data-anim]").forEach((el) => {
      if (!mounted.has(el.dataset.anim!)) el.classList.add("anim-in");
    });
    if (consumeScrollTop()) {
      const main = root.querySelector<HTMLElement>(".main");
      if (main) main.scrollTop = 0;
    }
  });
}

store.subscribe(render);
render(store.state);

// Drag and drop anywhere in the window.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  if (!store.state.dragOver) store.set({ dragOver: true });
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) store.set({ dragOver: false });
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  store.set({ dragOver: false });
  const files = Array.from(e.dataTransfer?.files ?? []);
  const paths = files.map((f) => api.getPathForFile(f)).filter(Boolean);
  if (store.state.install?.running) return;
  if (paths.length) void inspectPaths(paths);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (store.state.settingsOpen) closeSettings();
    else if (store.state.panel) closePanel();
    else if (store.state.devicesSheet) store.set({ devicesSheet: false });
    else if (store.state.menuOpen || store.state.rowMenu) store.set({ menuOpen: false, rowMenu: undefined });
  }
});

void bootstrap();
