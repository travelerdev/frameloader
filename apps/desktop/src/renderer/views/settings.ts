import { h, icon } from "../dom";
import type { State } from "../state";
import { checkForUpdates, closeSettings, updateSettings } from "../actions";

const REPO_URL = "https://github.com/travelerdev/frameloader";

export function settingsView(s: State): HTMLElement[] {
  const u = s.update;
  const checked = u?.checkedAt ? new Date(u.checkedAt).toLocaleString() : undefined;
  const updateLine = u?.available
    ? h("div", { class: "notice info" }, `Frameloader ${u.latest} is available. `, h("a", { href: u.url ?? `${REPO_URL}/releases/latest`, target: "_blank", rel: "noreferrer" }, "Download it from GitHub"))
    : u?.error
      ? h("div", { class: "help", style: "color: var(--danger)" }, `Last check failed: ${u.error}`)
      : checked
        ? h("div", { class: "help" }, `Up to date as of ${checked}.`)
        : null;

  return [
    h("div", { class: "overlay", "data-anim": "settings-overlay", onclick: () => closeSettings() }),
    h(
      "div",
      { class: "panel", "data-anim": "settings" },
      h("div", { class: "card-head" }, h("h3", {}, "Settings"), h("button", { class: "btn quiet sm", "aria-label": "Close", onclick: () => closeSettings() }, icon("x"))),
      h(
        "div",
        { class: "panel-body" },
        h(
          "section",
          { class: "stack" },
          h("h3", {}, "Updates"),
          h(
            "label",
            { class: "switch" },
            h("input", { type: "checkbox", checked: s.settings.checkForUpdates, onchange: (e: Event) => void updateSettings({ checkForUpdates: (e.target as HTMLInputElement).checked }) }),
            "Check GitHub for new versions",
          ),
          h(
            "p",
            { class: "help" },
            "Twice a day, Frameloader asks GitHub's public releases page for the latest version number and tells you if there's a newer one. Nothing about you or your headset is sent, and nothing is downloaded automatically.",
          ),
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn sm", disabled: s.checkingUpdate, onclick: () => void checkForUpdates() }, s.checkingUpdate ? h("span", { class: "spinner" }) : icon("refresh"), "Check now"),
            h("span", { class: "small muted" }, `You have version ${s.version || "?"}.`),
          ),
          updateLine,
        ),
        h("div", { class: "sep-line" }),
        h(
          "section",
          { class: "stack" },
          h("h3", {}, "Developer tools"),
          h(
            "label",
            { class: "switch" },
            h("input", { type: "checkbox", checked: s.settings.developerTools, onchange: (e: Event) => void updateSettings({ developerTools: (e.target as HTMLInputElement).checked }) }),
            "Show logs and the activity log",
          ),
          h(
            "p",
            { class: "help" },
            "For debugging an app that won't start. Adds a Logs tab that streams an Android app's output from the headset, and an activity log of every command Frameloader sends.",
          ),
        ),
        h("div", { class: "sep-line" }),
        h(
          "section",
          { class: "stack" },
          h("h3", {}, "About"),
          h(
            "p",
            { class: "help" },
            "Frameloader is free, open-source software with no warranty. ",
            h("a", { href: REPO_URL, target: "_blank", rel: "noreferrer" }, "Source code"),
            " · ",
            h("a", { href: "https://www.frameloader.com/terms", target: "_blank", rel: "noreferrer" }, "Terms of use"),
          ),
        ),
      ),
    ),
  ];
}

/** A thin banner when a newer release exists. */
export function updateBanner(s: State): HTMLElement | null {
  const u = s.update;
  if (!u?.available || !u.latest || s.updateDismissed === u.latest) return null;
  return h(
    "div",
    { class: "update-bar", "data-anim": "update-bar" },
    icon("info"),
    h("span", { class: "grow" }, `Frameloader ${u.latest} is available. You have ${u.current}.`),
    h("a", { class: "btn sm primary", href: u.url ?? `${REPO_URL}/releases/latest`, target: "_blank", rel: "noreferrer" }, "Get it"),
    h("button", { class: "btn sm quiet", "aria-label": "Dismiss", onclick: () => void import("../actions").then((a) => a.dismissUpdate()) }, icon("x")),
  );
}
