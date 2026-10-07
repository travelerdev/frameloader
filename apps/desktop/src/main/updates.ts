// Asks GitHub's public releases API whether a newer Frameloader exists.
// The request carries nothing but the app version in the User-Agent (GitHub
// requires one). It never downloads or installs anything: it only tells the
// renderer, which offers a link to the release page.
import { app, net } from "electron";
import { EventEmitter } from "node:events";
import type { UpdateInfo } from "../shared/ipc";
import { activity } from "./activity";
import { config } from "./config";
import { compareVersions } from "../shared/version";

export const REPO = "travelerdev/frameloader";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

class Updates extends EventEmitter {
  private timer?: NodeJS.Timeout;
  status: UpdateInfo = { current: app.getVersion(), available: false };

  start(): void {
    this.stop();
    if (!config.settings().checkForUpdates) return;
    this.timer = setTimeout(() => {
      void this.check();
      this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    }, FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
    }
    this.timer = undefined;
  }

  async check(): Promise<UpdateInfo> {
    const current = app.getVersion();
    try {
      const res = await net.fetch(LATEST_URL, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `Frameloader/${current}` },
        credentials: "omit",
        cache: "no-store",
      });
      if (res.status === 404) {
        this.status = { current, available: false, checkedAt: new Date().toISOString() };
      } else if (!res.ok) {
        throw new Error(`GitHub answered HTTP ${res.status}`);
      } else {
        const body = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean; assets?: unknown[] };
        const latest = (body.tag_name ?? "").replace(/^v/i, "");
        // A release is announced only once its installers are attached; the build takes a few minutes after publishing.
        const ready = Array.isArray(body.assets) && body.assets.length > 0;
        const available = !!latest && ready && !body.draft && !body.prerelease && compareVersions(latest, current) > 0;
        this.status = { current, latest, available, url: body.html_url, checkedAt: new Date().toISOString() };
        if (available) activity.info(`Frameloader ${latest} is available (you have ${current})`);
      }
    } catch (e) {
      this.status = { ...this.status, current, error: (e as Error).message, checkedAt: new Date().toISOString() };
    }
    this.emit("status", this.status);
    return this.status;
  }
}

export const updates = new Updates();
