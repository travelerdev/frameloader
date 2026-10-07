import { h, icon } from "../dom";
import { store, type State } from "../state";
import { activityPane } from "../actions";

/** Every command sent to the headset. Only shown with developer tools on. */
export function drawerView(s: State): HTMLElement {
  return h(
    "div",
    { class: "drawer" },
    h(
      "div",
      { class: "bar", onclick: () => store.set({ activityOpen: !s.activityOpen }) },
      h("span", { class: "row" }, icon("terminal"), "Activity"),
      h(
        "span",
        { class: "row" },
        s.activityOpen ? h("button", { class: "link small", onclick: (e: Event) => { e.stopPropagation(); void navigator.clipboard.writeText(activityPane.text()); } }, "Copy all") : null,
        h("span", {}, s.activityOpen ? "Hide" : "Show"),
      ),
    ),
    s.activityOpen ? activityPane.el : null,
  );
}
