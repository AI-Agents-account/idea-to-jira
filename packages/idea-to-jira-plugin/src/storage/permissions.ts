import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  statSync,
} from "node:fs";

export type StoragePermissionErrorCode =
  | "STORAGE_PATH_INVALID"
  | "STORAGE_PERMISSION_INVALID"
  | "STORAGE_FILE_EXISTS";

export class StoragePermissionError extends Error {
  constructor(readonly code: StoragePermissionErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "StoragePermissionError";
  }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function assertRuntimeOwner(path: string): void {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new StoragePermissionError("STORAGE_PERMISSION_INVALID");
  }
  const info = statSync(path);
  if (info.uid !== process.getuid() || info.gid !== process.getgid()) {
    throw new StoragePermissionError("STORAGE_PERMISSION_INVALID");
  }
}

function rejectSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new StoragePermissionError("STORAGE_PATH_INVALID");
}

export function assertPrivateDirectory(path: string): void {
  rejectSymlink(path);
  const info = statSync(path);
  if (!info.isDirectory()) throw new StoragePermissionError("STORAGE_PATH_INVALID");
  assertRuntimeOwner(path);
  if ((mode(path) & ~0o700) !== 0) throw new StoragePermissionError("STORAGE_PERMISSION_INVALID");
}

export function assertPrivateFile(path: string): void {
  rejectSymlink(path);
  const info = statSync(path);
  if (!info.isFile()) throw new StoragePermissionError("STORAGE_PATH_INVALID");
  assertRuntimeOwner(path);
  if ((mode(path) & ~0o600) !== 0) throw new StoragePermissionError("STORAGE_PERMISSION_INVALID");
}

export function assertExistingSqliteFileSet(databasePath: string): void {
  const databaseExists = existsSync(databasePath);
  const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`];
  if (!databaseExists && sidecars.some((path) => existsSync(path))) {
    throw new StoragePermissionError("STORAGE_PATH_INVALID");
  }
  for (const path of [databasePath, ...sidecars]) {
    if (existsSync(path)) assertPrivateFile(path);
  }
}

export function preparePrivateDatabaseFile(path: string): void {
  if (existsSync(path)) {
    assertPrivateFile(path);
    return;
  }
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
  chmodSync(path, 0o600);
  assertPrivateFile(path);
}

export function prepareNewPrivateFile(path: string): void {
  if (existsSync(path)) throw new StoragePermissionError("STORAGE_FILE_EXISTS");
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
  chmodSync(path, 0o600);
  assertPrivateFile(path);
}

export function enforceSqliteFileModes(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!existsSync(path)) continue;
    rejectSymlink(path);
    chmodSync(path, 0o600);
    assertPrivateFile(path);
  }
}
