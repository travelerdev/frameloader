// Tiny DOM helpers and Lucide line icons (MIT, lucide.dev).
type Child = Node | string | number | null | undefined | false | Child[];

export function h(tag: string, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "value" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) el.value = String(v);
    else if (k === "checked" && el instanceof HTMLInputElement) el.checked = Boolean(v);
    else if (k === "disabled" || k === "open" || k === "autofocus") {
      if (v) el.setAttribute(k, "");
    } else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

const ICONS: Record<string, string> = {
  upload: '<path d="M12 13v8"/><path d="m8 17 4-4 4 4"/><path d="M4 16.2A5 5 0 0 1 6.2 7h1.2A7 7 0 0 1 21 10.5a4.5 4.5 0 0 1-1 8.9"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  headset: '<path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H3z"/><path d="M21 11h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h3z"/><path d="M3 11v-1a9 9 0 0 1 18 0v1"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  android: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  windows: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18"/><path d="M12 3v18"/>',
  linux: '<path d="M12 3a4 4 0 0 0-4 4v3c0 2-2 3-2 6a6 6 0 0 0 12 0c0-3-2-4-2-6V7a4 4 0 0 0-4-4z"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  drop: '<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><rect x="4" y="15" width="16" height="6" rx="2"/>',
};

export function icon(name: string, cls = ""): HTMLElement {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
  const span = document.createElement("span");
  span.className = "icon-wrap";
  span.style.display = "inline-flex";
  span.innerHTML = svg;
  return span.firstElementChild as HTMLElement;
}

export function kindIcon(kind: string): HTMLElement {
  return icon(kind === "apk" ? "android" : kind === "windows" ? "windows" : kind.startsWith("linux") ? "linux" : "box");
}

/** Remember focus and caret across a full re-render. */
export function withFocusRestore(root: HTMLElement, render: () => void): void {
  const active = document.activeElement as HTMLElement | null;
  const id = active?.id;
  let sel: [number | null, number | null] | undefined;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    try {
      sel = [active.selectionStart, active.selectionEnd];
    } catch {
      /* type=checkbox etc. */
    }
  }
  const scrolls = new Map<string, number>();
  root.querySelectorAll<HTMLElement>("[data-scroll]").forEach((el) => scrolls.set(el.dataset.scroll!, el.scrollTop));
  const mainScroll = root.querySelector<HTMLElement>(".main")?.scrollTop ?? 0;
  const skipMainScroll = scrollTopRequested;
  render();
  if (id) {
    const next = document.getElementById(id);
    if (next) {
      next.focus({ preventScroll: true });
      if (sel && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) {
        try {
          next.setSelectionRange(sel[0], sel[1]);
        } catch {
          /* ignore */
        }
      }
    }
  }
  root.querySelectorAll<HTMLElement>("[data-scroll]").forEach((el) => {
    const key = el.dataset.scroll!;
    if (el.dataset.scrollBottom === "1") el.scrollTop = el.scrollHeight;
    else if (scrolls.has(key)) el.scrollTop = scrolls.get(key)!;
  });
  const main = root.querySelector<HTMLElement>(".main");
  if (main && !skipMainScroll) main.scrollTop = mainScroll;
}

let scrollTopRequested = false;
/** Ask the next render to scroll the main area to the top. */
export function requestScrollTop(): void {
  scrollTopRequested = true;
}
export function consumeScrollTop(): boolean {
  const v = scrollTopRequested;
  scrollTopRequested = false;
  return v;
}
