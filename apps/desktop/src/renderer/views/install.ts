import { formatBytes } from "../../shared/format";
import type { InstallStep } from "../../shared/ipc";
import { h, icon } from "../dom";
import type { State } from "../state";
import { installAnother, launchTitle } from "../actions";

const LABELS: Record<InstallStep, string> = { prepare: "Preparing on the headset", upload: "Uploading", register: "Registering with Steam", launch: "Launching" };

export function installView(s: State): HTMLElement {
  const st = s.install!;
  const result = st.result;
  const name = result?.name ?? s.review?.name ?? "";
  const steps = (Object.keys(LABELS) as InstallStep[]).map((k) => {
    const p = st.steps[k];
    const mark =
      p.status === "done" ? icon("check") : p.status === "failed" ? icon("x") : p.status === "active" ? h("span", { class: "spinner" }) : p.status === "skipped" ? h("span", { class: "small" }, "–") : null;
    const pct = p.step === "upload" && p.total ? Math.min(100, Math.round(((p.bytes ?? 0) / p.total) * 100)) : undefined;
    return h(
      "div",
      { class: `step ${p.status}` },
      h("div", { class: "mark" }, mark),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "label" }, LABELS[k] + (k === "upload" && p.status === "active" && p.total ? ` · ${formatBytes(p.bytes ?? 0)} of ${formatBytes(p.total)}` : "")),
        p.detail && !(k === "upload" && p.status === "active") ? h("div", { class: "detail" }, p.detail) : null,
        pct !== undefined && p.status === "active" ? h("div", { class: "progress" }, h("div", { style: `width:${pct}%` })) : null,
      ),
    );
  });

  let footer: HTMLElement | null = null;
  if (result?.ok) {
    footer = h(
      "div",
      { class: "stack" },
      h("div", { class: "notice ok" }, h("b", {}, name), " is in your Steam library under Non-Steam."),
      h("div", { class: "row" }, h("button", { class: "btn primary", onclick: () => void launchTitle(result.gameId) }, icon("play"), "Play now"), h("button", { class: "btn", onclick: () => installAnother() }, "Install another")),
    );
  } else if (result && !result.ok) {
    footer = h("div", { class: "row" }, h("button", { class: "btn", onclick: () => installAnother() }, "Back"));
  }

  return h("div", { class: "card", "data-anim": "install" }, h("div", { class: "card-body stack", style: "gap: 16px" }, h("div", {}, h("h2", {}, result?.ok ? "Installed" : st.running ? `Installing ${name}` : "Install failed"), result && !result.ok ? h("p", { class: "muted", style: "margin-top:4px" }, "Fix the problem below and try again.") : null), h("div", { class: "steps" }, ...steps), footer));
}
