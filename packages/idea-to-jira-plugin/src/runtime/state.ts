import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from "node:fs";

/** Creates and verifies the plugin-owned state root with the NFR-020 directory mode. */
export function ensurePrivateStateDirectory(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("STATE_DIR_INVALID");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const info = statSync(path);
  const mode = info.mode & 0o777;
  if (!info.isDirectory() || mode !== 0o700) throw new Error("STATE_DIR_INVALID");
}
