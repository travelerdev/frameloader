import { timeAgo } from "../../shared/format";
import { h, icon } from "../dom";
import { store, type State } from "../state";
import { connectSaved, removeDevice, renameDevice } from "../actions";

export function devicesView(s: State): HTMLElement[] {
  const close = () => store.set({ devicesSheet: false });
  const rows = s.devices.map((d) =>
    h(
      "div",
      { class: "title-row" },
      h("div", { class: "icon" }, icon("headset")),
      h(
        "div",
        { class: "grow" },
        h("input", { id: `nick-${d.id}`, class: "name-input", style: "font-size:14px;font-weight:500;padding:2px 6px", value: d.nickname, onchange: (e: Event) => void renameDevice(d.id, (e.target as HTMLInputElement).value) }),
        h("div", { class: "meta" }, `${d.user}@${d.host}${d.port !== 22 ? ":" + d.port : ""} · ${d.auth === "key" ? "Paired" : d.hasSavedPassword ? "Password saved" : "Password"}${d.lastSeen ? " · last seen " + timeAgo(d.lastSeen) : ""}`),
      ),
      s.connection.deviceId === d.id && s.connection.status === "connected" ? h("span", { class: "chip ok" }, "Connected") : h("button", { class: "btn sm", onclick: () => void connectSaved(d.id) }, "Connect"),
      h("button", { class: "btn sm quiet", "aria-label": "Forget", title: "Forget this headset", onclick: () => void removeDevice(d.id) }, icon("trash")),
    ),
  );
  return [
    h("div", { class: "overlay", "data-anim": "devices-overlay", onclick: close }),
    h(
      "div",
      { class: "panel", "data-anim": "devices" },
      h("div", { class: "card-head" }, h("h3", {}, "Headsets"), h("button", { class: "btn quiet sm", "aria-label": "Close", onclick: close }, icon("x"))),
      h(
        "div",
        { class: "panel-body" },
        h("div", { class: "titles" }, rows.length ? rows : h("div", { class: "empty" }, "No saved headsets.")),
        h("button", { class: "btn", onclick: () => { store.set({ devicesSheet: false }); void import("../actions").then((a) => a.disconnect()); } }, icon("plus"), "Add another headset"),
        h("p", { class: "help" }, "Forgetting a headset removes its saved password and SSH identity from this computer. The pairing key stays on the headset until you turn Developer Mode off."),
      ),
    ),
  ];
}
