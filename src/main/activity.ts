// Activity log: every command sent to the headset and what came back.
// Kept in memory (last 2000 lines) and pushed to the renderer.
import { EventEmitter } from "node:events";
import type { LogLevel, LogLine } from "../shared/ipc";

const MAX = 2000;

class Activity extends EventEmitter {
  private lines: LogLine[] = [];

  push(level: LogLevel, text: string): void {
    const line: LogLine = { ts: Date.now(), level, text };
    this.lines.push(line);
    if (this.lines.length > MAX) this.lines.splice(0, this.lines.length - MAX);
    this.emit("line", line);
  }

  info(text: string): void {
    this.push("info", text);
  }

  recent(): LogLine[] {
    return this.lines.slice(-500);
  }
}

export const activity = new Activity();
