// Files Frameloader ships beside its code (see electron-builder's extraResources).
import { join } from "node:path";
import { app } from "electron";

/** vendor/<rel> in a dev checkout, Resources/<rel> in the packaged app. */
export function vendorPath(...rel: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, ...rel) : join(app.getAppPath(), "vendor", ...rel);
}

/** The Khronos OpenXR loader that replaces Meta's in Quest apps. */
export function openXrLoaderPath(): string {
  return vendorPath("openxr-loader", "arm64-v8a", "libopenxr_loader.so");
}
