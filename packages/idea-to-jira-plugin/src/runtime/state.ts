import { chmodSync, mkdirSync, statSync } from "node:fs";

/** Creates the plugin-owned state root with the NFR-020 directory mode. */
export function ensurePrivateStateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o700) throw new Error("STATE_DIR_INVALID");
}
