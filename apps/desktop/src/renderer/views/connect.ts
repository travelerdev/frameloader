import { h, icon } from "../dom";

const TERMS_URL = "https://www.frameloader.com/terms";
import { store, type State } from "../state";
import { cancelPair, connectSaved, connectWithPassword, discoverOnce, openSettings, pair, useDiscovered } from "../actions";

export function connectView(s: State): HTMLElement {
  const f = s.connectForm;
  const pairing = s.connection.status === "pairing" || s.connection.status === "connecting";
  const setForm = (patch: Partial<typeof f>) => store.set((st) => ({ connectForm: { ...st.connectForm, ...patch } }));
  const saved = s.devices;

  const hostField = h(
    "div",
    { class: "field" },
    h("label", { for: "host" }, "Hostname or IP address"),
    h("input", {
      id: "host",
      class: "input",
      value: f.host,
      placeholder: "frame.local",
      autocomplete: "off",
      spellcheck: "false",
      disabled: pairing,
      oninput: (e: Event) => setForm({ host: (e.target as HTMLInputElement).value }),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Enter") void (f.mode === "pair" ? pair() : connectWithPassword());
      },
    }),
    h("div", { class: "help" }, "Changed the hostname in Steam Settings → System? Enter it here. Frameloader finds the address itself, so .local is optional."),
  );

  const searching = s.discovering || !s.discoveryDone;
  const found = h(
    "div",
    { class: "found" },
    s.discovered.length
      ? h(
          "div",
          { class: "row spread small muted", style: "gap: 8px" },
          h("span", { class: "row", style: "gap: 8px" }, icon("headset"), "Found on your network"),
          h("button", { class: "link small", disabled: searching || pairing, onclick: () => void discoverOnce() }, searching ? "Searching…" : "Search again"),
        )
      : searching
        ? h("div", { class: "row small muted", style: "gap: 8px" }, h("span", { class: "spinner" }), "Looking for headsets on your network…")
        : h(
            "div",
            { class: "row spread small muted", style: "gap: 8px" },
            h("span", { class: "row", style: "gap: 8px" }, icon("headset"), "No headset found. Developer Mode must be on and the Frame awake."),
            h("button", { class: "btn sm", style: "white-space: nowrap; flex: none", disabled: pairing, onclick: () => void discoverOnce() }, icon("refresh"), "Click to try again"),
          ),
    s.discovered.length
      ? h(
          "div",
          { class: "row wrap", style: "gap: 6px" },
          ...s.discovered.map((d) =>
            h(
              "button",
              { class: "btn sm" + (label(f.host) === label(d.host) ? " on" : ""), disabled: pairing, title: d.address ? `${d.host} · ${d.address}` : d.host, onclick: () => useDiscovered(d.host) },
              icon("headset"),
              d.name,
              d.address ? h("span", { class: "muted mono", style: "font-size: 12px" }, d.address) : null,
            ),
          ),
        )
      : null,
  );


  const pairBlock = h(
    "div",
    { class: "stack" },
    pairing
      ? h(
          "div",
          { class: "notice info row" },
          h("span", { class: "spinner" }),
          h("div", { class: "grow" }, h("div", {}, s.connection.message ?? "Waiting for the headset…"), h("div", { class: "small muted" }, (s.connection.address ? `${s.connection.address} · ` : "") + "On the headset: Settings → Developer → Pair new host, then approve.")),
          s.connection.status === "pairing" ? h("button", { class: "link", onclick: () => void cancelPair() }, "Cancel") : null,
        )
      : h("button", { class: "btn primary", onclick: () => void pair() }, icon("headset"), "Pair with headset"),
    !pairing ? h("div", { class: "help" }, "Recommended. No password is typed on this computer; you approve a prompt in the headset.") : null,
  );

  const passwordBlock = h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "row" },
      h("div", { class: "field", style: "flex: 0 0 160px" }, h("label", { for: "user" }, "User"), h("input", { id: "user", class: "input", value: f.user, disabled: pairing, oninput: (e: Event) => setForm({ user: (e.target as HTMLInputElement).value }) })),
      h(
        "div",
        { class: "field grow" },
        h("label", { for: "password" }, "Developer Mode password"),
        h("input", {
          id: "password",
          class: "input",
          type: "password",
          value: f.password,
          disabled: pairing,
          oninput: (e: Event) => setForm({ password: (e.target as HTMLInputElement).value }),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === "Enter") void connectWithPassword();
          },
        }),
      ),
    ),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: f.remember, onchange: (e: Event) => setForm({ remember: (e.target as HTMLInputElement).checked }) }), "Remember the password on this computer"),
    h("div", { class: "row" }, h("button", { class: "btn primary", disabled: pairing, onclick: () => void connectWithPassword() }, pairing ? h("span", { class: "spinner" }) : icon("headset"), pairing ? "Connecting…" : "Connect")),
    h("div", { class: "help" }, "Set under Settings → Developer → Set User Password on the headset."),
  );

  const card = h(
    "div",
    { class: "card", style: "width: min(560px, 100%)" },
    h(
      "div",
      { class: "card-body stack", style: "gap: 18px" },
      h("div", {}, h("h1", {}, "Connect your Frame"), h("p", { class: "muted", style: "margin-top: 4px" }, "Frameloader talks to your headset over your local network.")),
      hostField,
      found,
      f.mode === "pair" ? pairBlock : passwordBlock,
      f.error ? h("div", { class: "notice bad" }, f.error) : null,
      h(
        "p",
        { class: "help" },
        "Frameloader is free software with no warranty. By connecting, you accept the ",
        h("a", { href: TERMS_URL, target: "_blank", rel: "noreferrer" }, "terms of use"),
        " and use it at your own risk.",
      ),
      h(
        "div",
        { class: "row spread wrap" },
        f.mode === "pair"
          ? h("button", { class: "link", disabled: pairing, onclick: () => setForm({ mode: "password", error: undefined }) }, "Connect with the Developer Mode password instead")
          : h("button", { class: "link", disabled: pairing, onclick: () => setForm({ mode: "pair", error: undefined }) }, "Pair with the headset instead"),
        saved.length
          ? h(
              "div",
              { class: "row" },
              h("span", { class: "small muted" }, "Saved:"),
              ...saved.map((d) => h("button", { class: "btn sm", disabled: pairing, onclick: () => void connectSaved(d.id) }, d.nickname)),
            )
          : null,
      ),
    ),
  );

  const checklist = h(
    "div",
    { class: "checklist" },
    step(1, "Enable Developer Mode", "Steam Settings → System → Enable Developer Mode."),
    step(2, "Set a user password", "Settings → Developer → Set User Password. There is no default."),
    step(3, "Open Pair new host", "Settings → Developer → Pair new host, when you click Pair."),
  );

  const brand = h("div", { class: "brand brand-lg" }, h("img", { class: "logo", src: "logo.png", alt: "" }), "Frameloader");

  const settingsBtn = h("button", { class: "btn sm quiet corner", "aria-label": "Settings", title: "Settings", onclick: () => openSettings() }, icon("settings"));

  return h("div", { class: "main" }, settingsBtn, h("div", { class: "center" }, brand, card, checklist));
}

function step(n: number, title: string, text: string): HTMLElement {
  return h("div", { class: "item" }, h("div", { class: "num" }, String(n)), h("div", {}, h("b", {}, title), h("span", {}, text)));
}

function label(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/\.local$/, "");
}
