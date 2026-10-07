// A log view that lives outside the render loop: lines are appended straight
// to one long-lived element, so streaming output never re-renders the app and
// you can select text while it runs. Views just place `pane.el` in the tree.
export class LivePane {
  readonly el: HTMLDivElement;
  private lines: string[] = [];
  private filter = "";
  private paused = false;

  /** `key` lets the render loop keep this pane's scroll position across re-renders. */
  constructor(private readonly max = 3000, key = "log") {
    this.el = document.createElement("div");
    this.el.className = "logpane";
    this.el.tabIndex = 0;
    this.el.dataset.scroll = key;
  }

  get count(): number {
    return this.lines.length;
  }

  text(): string {
    return this.visible().join("\n");
  }

  append(line: string, kind?: string): void {
    this.lines.push(line);
    if (this.lines.length > this.max) {
      this.lines.splice(0, this.lines.length - this.max);
      if (this.el.childElementCount > this.max) this.el.firstElementChild?.remove();
    }
    if (this.paused || !this.matches(line)) return;
    const stick = this.atBottom();
    const row = document.createElement("div");
    row.textContent = line;
    if (kind) row.className = kind;
    this.el.appendChild(row);
    if (stick) this.el.scrollTop = this.el.scrollHeight;
  }

  setFilter(filter: string): void {
    this.filter = filter.trim().toLowerCase();
    this.redraw();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.redraw();
  }

  clear(): void {
    this.lines = [];
    this.el.replaceChildren();
  }

  private matches(line: string): boolean {
    return !this.filter || line.toLowerCase().includes(this.filter);
  }

  private visible(): string[] {
    return this.lines.filter((l) => this.matches(l));
  }

  private atBottom(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 24;
  }

  private redraw(): void {
    const frag = document.createDocumentFragment();
    for (const l of this.visible()) {
      const row = document.createElement("div");
      row.textContent = l;
      frag.appendChild(row);
    }
    this.el.replaceChildren(frag);
    this.el.scrollTop = this.el.scrollHeight;
  }
}
