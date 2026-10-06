import type { FrameloaderApi } from "../shared/ipc";
import { installMock } from "./mock";

declare global {
  interface Window {
    frameloader?: FrameloaderApi;
  }
}

if (!window.frameloader) installMock();

export const api: FrameloaderApi = window.frameloader!;
export const isMock = !!(window as unknown as { __frameloaderMock?: boolean }).__frameloaderMock;
