import { statSync } from "node:fs";

import { openPluginDatabase } from "/app/extensions/idea-to-jira-plugin/dist/src/storage/database.js";

const stateDir = process.env.IDEA_TO_JIRA_STORAGE_CHECK_DIR ?? "/home/node/.openclaw/plugin-state/container-check";
const expectedDirectoryMode = 0o700;
const expectedFileMode = 0o600;

function mode(path) {
  return statSync(path).mode & 0o777;
}

function assertRuntimeOwner(path) {
  const info = statSync(path);
  if (info.uid !== process.getuid() || info.gid !== process.getgid()) {
    throw new Error("STORAGE_OWNER_CHECK_FAILED");
  }
}

let storage = openPluginDatabase({ stateDir });
storage.repositories.criticalTransaction(({ sql }) => {
  sql.prepare("INSERT OR IGNORE INTO users(id, telegram_sender_id) VALUES (?, ?)").run(
    "container-check-user",
    "123456789",
  );
});
const databasePath = storage.path;
storage.close();

storage = openPluginDatabase({ stateDir });
const row = storage.repositories.transaction(({ sql }) =>
  sql.prepare("SELECT telegram_sender_id FROM users WHERE id = ?").get("container-check-user"),
);
if (row?.telegram_sender_id !== "123456789") throw new Error("STORAGE_RESTART_CHECK_FAILED");
if (storage.health.schemaVersion !== 3) throw new Error("STORAGE_SCHEMA_CHECK_FAILED");
if (mode(stateDir) !== expectedDirectoryMode || mode(databasePath) !== expectedFileMode) {
  throw new Error("STORAGE_MODE_CHECK_FAILED");
}
assertRuntimeOwner(stateDir);
assertRuntimeOwner(databasePath);
storage.close();

console.log("storage-container-check: schema=3 journal=wal modes=private restart=ok");
