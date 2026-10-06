import { h, icon } from "../dom";
import { store, type State } from "../state";

export function drawerView(s: State): HTMLElement {
  const lines = s.activity;
  const fmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });
  return h(
    "div",
    { class: "drawer" },
    h(
      "div",
      { class: "bar", onclick: () => store.set({ activityOpen: !s.activityOpen }) },
      h("span", { class: "row" }, icon("terminal"), `Activity${lines.length ? ` · ${lines.length}` : ""}`),
      h(
        "span",
        { class: "row" },
        s.activityOpen ? h("button", { class: "link small", onclick: (e: Event) => { e.stopPropagation(); void navigator.clipboard.writeText(lines.map((l) => `${fmt(l.ts)} [${l.level}] ${l.text}`).join("\n")); } }, "Copy all") : null,
        h("span", {}, s.activityOpen ? "Hide" : "Show"),
      ),
    ),
    s.activityOpen
      ? h(
          "div",
          { class: "logpane", "data-scroll": "activity", "data-scroll-bottom": "1" },
          ...lines.map((l) => h("div", { class: l.level }, `${fmt(l.ts)}  ${l.level === "cmd" ? "$ " : ""}${l.text}`)),
        )
      : null,
  );
}
