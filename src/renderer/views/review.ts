import { formatBytes } from "../../shared/format";
import type { RuntimeId } from "../../shared/ipc";
import { gameIdProblem } from "../../shared/gameid";
import { h, icon, kindIcon } from "../dom";
import type { State } from "../state";
import { cancelReview, setReviewName, startInstall, updateReview } from "../actions";

export function reviewView(s: State): HTMLElement {
  const p = s.payload!;
  const r = s.review!;
  const offline = s.connection.status !== "connected";
  const idProblem = gameIdProblem(r.gameId);
  const chosen = s.runtimes.find((x) => x.id === r.runtime);
  const blocking = [...p.issues];
  if (chosen && !chosen.available && chosen.unavailableReason) blocking.push(chosen.unavailableReason);
  if (!s.runtimes.length) blocking.push("No runtime on the headset can run this.");

  const facts: HTMLElement[] = [];
  if (p.apk) {
    facts.push(chip("Android"));
    facts.push(chip(p.apk.abis.length ? (p.apk.abis.includes("arm64-v8a") ? "arm64" : p.apk.abis.join(", ")) : "no native code"));
    facts.push(chip(p.apk.isVr ? "VR app" : "2D app"));
    if (p.apk.versionName) facts.push(chip(`v${p.apk.versionName}`));
    if (p.apk.minSdk) facts.push(chip(`minSdk ${p.apk.minSdk}`));
    if (p.apk.obbFiles.length) facts.push(chip(`${p.apk.obbFiles.length} OBB`));
  } else {
    const top = p.candidates?.[0];
    facts.push(chip(p.kind === "windows" ? `Windows ${top?.arch ?? ""}`.trim() : p.kind === "linux-arm64" ? "Linux ARM64" : p.kind === "linux-x64" ? "Linux x86-64" : "Unknown build"));
    if (p.candidates && p.candidates.length > 1) facts.push(chip(`Found ${p.candidates.length} executables`));
  }
  facts.push(chip(formatBytes(p.sizeBytes)));

  const runtimeControl = h(
    "div",
    { class: "field" },
    h("label", {}, "Runtime"),
    h(
      "div",
      { class: "row wrap" },
      h(
        "div",
        { class: "segmented" },
        ...s.runtimes.map((opt) =>
          h("button", { class: opt.id === r.runtime ? "on" : "", disabled: !opt.available && opt.id !== r.runtime, title: opt.unavailableReason ?? opt.note ?? "", onclick: () => updateReview({ runtime: opt.id as RuntimeId }) }, opt.label),
        ),
      ),
      chosen?.note ? h("span", { class: "help" }, chosen.note) : null,
    ),
  );

  const advanced = h(
    "details",
    { class: "advanced", open: r.advancedOpen, ontoggle: (e: Event) => { const open = (e.target as HTMLDetailsElement).open; if (open !== r.advancedOpen) updateReview({ advancedOpen: open }); } },
    h("summary", {}, icon("chevron"), "Advanced"),
    h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "field" },
        h("label", { for: "gameid" }, "Library ID"),
        h("input", { id: "gameid", class: "input mono", value: r.gameId, spellcheck: "false", oninput: (e: Event) => updateReview({ gameId: (e.target as HTMLInputElement).value, gameIdTouched: true }) }),
        h("div", { class: "help" + (idProblem ? " bad" : "") , style: idProblem ? "color: var(--danger)" : "" }, idProblem ?? "Steam shows this as “Devkit Game: ID”. Reusing an ID updates that title in place."),
      ),
      p.candidates && p.candidates.length
        ? h(
            "div",
            { class: "field" },
            h("label", { for: "start" }, "Start command"),
            h(
              "select",
              { id: "start", class: "select mono", onchange: (e: Event) => updateReview({ startCommand: (e.target as HTMLSelectElement).value }) },
              ...p.candidates.map((c) => h("option", { value: c.relPath, selected: c.relPath === r.startCommand ? "" : undefined }, `${c.relPath}  (${c.format === "pe" ? "Windows" : c.format === "elf" ? "Linux" : "script"} ${c.arch})`)),
            ),
          )
        : null,
      h("div", { class: "field" }, h("label", { for: "args" }, p.kind === "apk" ? "Launch arguments (UECommandLine.txt)" : "Launch arguments"), h("input", { id: "args", class: "input mono", value: r.launchArgs, spellcheck: "false", oninput: (e: Event) => updateReview({ launchArgs: (e.target as HTMLInputElement).value }) })),
      h(
        "div",
        { class: "field" },
        h("label", {}, "Environment variables"),
        ...r.env.map((e, i) =>
          h(
            "div",
            { class: "kv" },
            h("input", { id: `envk${i}`, class: "input mono", placeholder: "NAME", value: e.k, oninput: (ev: Event) => setEnv(r.env, i, { k: (ev.target as HTMLInputElement).value }) }),
            h("input", { id: `envv${i}`, class: "input mono", placeholder: "value", value: e.v, oninput: (ev: Event) => setEnv(r.env, i, { v: (ev.target as HTMLInputElement).value }) }),
            h("button", { class: "btn sm quiet", "aria-label": "Remove", onclick: () => updateReview({ env: r.env.filter((_, j) => j !== i) }) }, icon("x")),
          ),
        ),
        h("div", {}, h("button", { class: "btn sm", onclick: () => updateReview({ env: [...r.env, { k: "", v: "" }] }) }, icon("plus"), "Add variable")),
      ),
      p.kind === "apk"
        ? h(
            "div",
            { class: "field" },
            h("label", { class: "switch" }, h("input", { type: "checkbox", checked: r.flatscreen, onchange: (e: Event) => updateReview({ flatscreen: (e.target as HTMLInputElement).checked }) }), "Show a 2D window"),
            h("div", { class: "help" }, "VR apps don't need this; flat apps are invisible without it."),
          )
        : null,
    ),
  );

  return h(
    "div",
    { class: "card", "data-anim": "review" },
    h(
      "div",
      { class: "card-body stack", style: "gap: 16px" },
      h(
        "div",
        { class: "review-head" },
        h("div", { class: "icon" }, p.apk?.iconDataUrl ? h("img", { src: p.apk.iconDataUrl, alt: "" }) : kindIcon(p.kind)),
        h(
          "div",
          { class: "grow stack", style: "gap: 6px" },
          h("input", { id: "name", class: "name-input", value: r.name, "aria-label": "Title name", spellcheck: "false", oninput: (e: Event) => setReviewName((e.target as HTMLInputElement).value) }),
          h("div", { class: "row wrap", style: "gap: 6px; padding-left: 8px" }, ...facts),
          p.apk ? h("div", { class: "small muted mono", style: "padding-left: 8px" }, p.apk.package) : null,
        ),
      ),
      p.updates ? h("div", { class: "notice info" }, `Updates “${p.updates.name}”${p.updates.fromVersion && p.apk?.versionName ? ` (${p.updates.fromVersion} → ${p.apk.versionName})` : ""}. Save data is kept.`) : null,
      ...blocking.map((b) => h("div", { class: "notice bad" }, b)),
      ...p.warnings.map((w) => h("div", { class: "notice" }, w)),
      runtimeControl,
      advanced,
      h(
        "div",
        { class: "row spread wrap", style: "padding-top: 4px" },
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: r.launchAfter, onchange: (e: Event) => updateReview({ launchAfter: (e.target as HTMLInputElement).checked }) }), "Launch on the headset after installing"),
        h(
          "div",
          { class: "row" },
          h("button", { class: "link", onclick: () => cancelReview() }, "Cancel"),
          h("button", { class: "btn primary", disabled: offline || blocking.length > 0 || !!idProblem || !r.runtime, title: offline ? "Connect to the headset first." : "", onclick: () => void startInstall() }, icon("upload"), "Install to Frame"),
        ),
      ),
    ),
  );
}

function setEnv(env: { k: string; v: string }[], i: number, patch: Partial<{ k: string; v: string }>): void {
  updateReview({ env: env.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
}

function chip(text: string): HTMLElement {
  return h("span", { class: "chip" }, text);
}
