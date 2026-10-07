// Library IDs are what Steam shows as "Devkit Game: <id>" and what Valve's
// scripts pass to a shell, so they are kept to a conservative subset of what
// Steam accepts (^[A-Za-z_][A-Za-z0-9_.]+$).

export const RESERVED_GAME_IDS = new Set(["steam", "steamvr", "steamdeckard", "steamvrdeckard"]);
export const GAME_ID_RE = /^[A-Za-z_][A-Za-z0-9_]{1,63}$/;

export function toGameId(name: string): string {
  let id = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!id) id = "Title";
  if (!/^[A-Za-z_]/.test(id)) id = "_" + id;
  if (RESERVED_GAME_IDS.has(id.toLowerCase())) id += "_game";
  if (id.length < 2) id += "_app";
  return id.slice(0, 64);
}

export function gameIdProblem(id: string): string | null {
  if (!GAME_ID_RE.test(id)) return "Use 2 to 64 letters, digits or underscores, not starting with a digit.";
  if (RESERVED_GAME_IDS.has(id.toLowerCase())) return "That ID is reserved by Steam.";
  return null;
}
