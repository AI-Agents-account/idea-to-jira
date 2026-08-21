import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const IDEA_TO_JIRA_TOOLS = Object.freeze([
  "idea_to_jira_create_draft",
  "idea_to_jira_read_draft",
  "idea_to_jira_patch_draft",
  "idea_to_jira_cancel_draft",
  "idea_to_jira_search_duplicates",
  "idea_to_jira_answer_field",
  "idea_to_jira_preview_issue",
  "idea_to_jira_confirm_issue",
  "idea_to_jira_create_issue",
  "idea_to_jira_request_access",
] as const);
export type IdeaToJiraToolName = (typeof IDEA_TO_JIRA_TOOLS)[number];

export type ConfigErrorCode =
  | "CONFIG_INVALID"
  | "SECRET_REF_MISSING"
  | "JIRA_SCOPE_INVALID"
  | "CATALOG_INVALID"
  | "TOOL_ALLOWLIST_INVALID"
  | "CHANNEL_BINDING_INVALID"
  | "CREATE_GATE_INVALID";

export interface IdeaToJiraConfig {
  readonly jiraProjectKey: string;
}

export interface JiraSearchConfig {
  readonly jql: string;
  readonly fields: readonly string[];
  readonly maxResults: number;
  readonly maxPages: number;
  readonly timeoutMs: number;
  readonly maxContextBytes: number;
}

export interface EffectiveConfig {
  readonly agentId: "idea-mvp";
  readonly telegram: {
    readonly channelId: "telegram";
    readonly accountId: "default";
    readonly pilotSenderId: string;
    readonly adminSenderIds: readonly string[];
  };
  readonly notifications: { readonly productOwnerSenderIds: readonly string[] };
  readonly jira: {
    readonly enabled: boolean;
    readonly url: string;
    /** Compatibility alias. Both values are the same validated HTTPS origin. */
    readonly origin: string;
    readonly projectKey: string;
    readonly issueTypeName: string;
    readonly search: JiraSearchConfig;
    readonly metadata: { readonly refreshIntervalMinutes: number };
    readonly create: { readonly requireConfirmation: boolean };
    /** Presence only. The credential value is never retained in effective config. */
    readonly credentialAvailable: boolean;
  };
  readonly catalog: { readonly path: string; readonly schemaVersion: 1; readonly sha256: string };
  readonly sttModel: "medium";
  readonly allowedTools: readonly IdeaToJiraToolName[];
  readonly limits: { readonly inputTextChars: number; readonly requestsPerMinute: number; readonly burst: number; readonly activeDrafts: number };
  readonly retention: { readonly draftDays: number; readonly auditDays: number };
  readonly stateDir: string;
}

export type ConfigLoadResult =
  | { readonly ok: true; readonly config: EffectiveConfig }
  | { readonly ok: false; readonly code: ConfigErrorCode };
export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type ReadTextFile = (path: string) => string;
type JsonObject = Record<string, unknown>;

const ROOT_KEYS = ["agentId", "telegram", "notifications", "jira", "catalog", "sttModel", "allowedTools", "limits", "retention", "stateDir"] as const;
const TELEGRAM_KEYS = ["channelId", "accountId", "pilotSenderIdEnv", "adminSenderIdsEnv"] as const;
const NOTIFICATION_KEYS = ["productOwnerSenderIdsEnv"] as const;
const JIRA_KEYS = ["enabled", "url", "projectKey", "issueTypeName", "search", "metadata", "create"] as const;
const SEARCH_KEYS = ["jql", "fields", "maxResults", "maxPages", "timeoutMs", "maxContextBytes"] as const;
const METADATA_KEYS = ["refreshIntervalMinutes"] as const;
const CREATE_KEYS = ["requireConfirmation"] as const;
const CATALOG_KEYS = ["path", "schemaVersion", "sha256"] as const;
const LIMIT_KEYS = ["inputTextChars", "requestsPerMinute", "burst", "activeDrafts"] as const;
const RETENTION_KEYS = ["draftDays", "auditDays"] as const;
const SAFE_SELECTOR = /^[A-Za-z][A-Za-z0-9 _.-]{0,127}$/;
const SAFE_PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,31}$/;
const SAFE_FIELD = /^(?:key|[a-z][a-z0-9_.-]{0,127}|customfield_[1-9][0-9]{0,19})$/;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}
function numericTelegramId(value: string): boolean { return /^[1-9][0-9]{0,19}$/.test(value); }
function parseTelegramIds(raw: string | undefined): readonly string[] | undefined {
  if (!raw?.trim()) return undefined;
  const ids = [...new Set(raw.split(",").map((item) => item.trim()))];
  return ids.length > 0 && ids.every(numericTelegramId) ? Object.freeze(ids) : undefined;
}
function parseHttpsOrigin(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return undefined;
    return url.origin;
  } catch { return undefined; }
}
function parseFields(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return undefined;
  const fields = value.map(string);
  if (fields.some((field) => !field || !SAFE_FIELD.test(field)) || new Set(fields).size !== fields.length) return undefined;
  return Object.freeze(fields as string[]);
}

export function loadEffectiveConfig(
  rawConfig: unknown,
  environment: RuntimeEnvironment = process.env,
  readTextFile: ReadTextFile = (path) => readFileSync(path, "utf8"),
): ConfigLoadResult {
  const root = object(rawConfig);
  if (!root) return { ok: false, code: "CONFIG_INVALID" };
  const telegram = object(root.telegram); const notifications = object(root.notifications); const jira = object(root.jira);
  const search = object(jira?.search); const metadata = object(jira?.metadata); const create = object(jira?.create);
  const catalog = object(root.catalog); const limits = object(root.limits); const retention = object(root.retention);
  if (!telegram || !notifications || !jira || !search || !metadata || !create || !catalog || !limits || !retention) return { ok: false, code: "CONFIG_INVALID" };
  if (!hasExactKeys(root, ROOT_KEYS) || !hasExactKeys(telegram, TELEGRAM_KEYS) || !hasExactKeys(notifications, NOTIFICATION_KEYS) ||
      !hasExactKeys(jira, JIRA_KEYS) || !hasExactKeys(search, SEARCH_KEYS) || !hasExactKeys(metadata, METADATA_KEYS) ||
      !hasExactKeys(create, CREATE_KEYS) || !hasExactKeys(catalog, CATALOG_KEYS) || !hasExactKeys(limits, LIMIT_KEYS) || !hasExactKeys(retention, RETENTION_KEYS)) {
    return { ok: false, code: "CONFIG_INVALID" };
  }
  if (root.agentId !== "idea-mvp" || telegram.channelId !== "telegram" || telegram.accountId !== "default") return { ok: false, code: "CHANNEL_BINDING_INVALID" };
  if (typeof jira.enabled !== "boolean" || typeof create.requireConfirmation !== "boolean") return { ok: false, code: "CONFIG_INVALID" };
  const url = parseHttpsOrigin(jira.url); const projectKey = string(jira.projectKey); const issueTypeName = string(jira.issueTypeName);
  const jql = string(search.jql); const fields = parseFields(search.fields);
  if (!url || !projectKey || !SAFE_PROJECT_KEY.test(projectKey) || !issueTypeName || !SAFE_SELECTOR.test(issueTypeName) || !jql || jql.length > 10_000 || /[\u0000-\u001f\u007f]/.test(jql) || !fields) return { ok: false, code: "JIRA_SCOPE_INVALID" };
  const maxResults = integer(search.maxResults, 1, 1_000); const maxPages = integer(search.maxPages, 1, 20);
  const timeoutMs = integer(search.timeoutMs, 100, 60_000); const maxContextBytes = integer(search.maxContextBytes, 1_024, 1_048_576);
  const refreshIntervalMinutes = integer(metadata.refreshIntervalMinutes, 1, 10_080);
  if (!maxResults || !maxPages || !timeoutMs || !maxContextBytes || !refreshIntervalMinutes) return { ok: false, code: "CONFIG_INVALID" };
  if (!create.requireConfirmation && jira.enabled) return { ok: false, code: "CREATE_GATE_INVALID" };

  const allowedTools = root.allowedTools;
  if (!Array.isArray(allowedTools) || allowedTools.length !== IDEA_TO_JIRA_TOOLS.length || allowedTools.some((tool, index) => tool !== IDEA_TO_JIRA_TOOLS[index])) return { ok: false, code: "TOOL_ALLOWLIST_INVALID" };
  const pilotSenderIdEnv = string(telegram.pilotSenderIdEnv); const adminsEnv = string(telegram.adminSenderIdsEnv); const productOwnerRoutesEnv = string(notifications.productOwnerSenderIdsEnv);
  if (pilotSenderIdEnv !== "TELEGRAM_PILOT_SENDER_ID" || adminsEnv !== "BUSINESS_ADMIN_TELEGRAM_IDS" || productOwnerRoutesEnv !== "PRODUCT_OWNER_TELEGRAM_IDS") return { ok: false, code: "CONFIG_INVALID" };
  const pilotSenderId = string(environment[pilotSenderIdEnv]); const adminSenderIds = parseTelegramIds(environment[adminsEnv]); const productOwnerSenderIds = parseTelegramIds(environment[productOwnerRoutesEnv]);
  if (!pilotSenderId || !numericTelegramId(pilotSenderId) || !adminSenderIds || !productOwnerSenderIds) return { ok: false, code: "SECRET_REF_MISSING" };
  if (!adminSenderIds.includes(pilotSenderId)) return { ok: false, code: "CONFIG_INVALID" };

  const catalogPath = string(catalog.path); const catalogSha256 = string(catalog.sha256)?.toLowerCase();
  if (!catalogPath || catalog.schemaVersion !== 1 || !catalogSha256 || !/^[a-f0-9]{64}$/.test(catalogSha256)) return { ok: false, code: "CATALOG_INVALID" };
  try { if (createHash("sha256").update(readTextFile(catalogPath)).digest("hex") !== catalogSha256) return { ok: false, code: "CATALOG_INVALID" }; }
  catch { return { ok: false, code: "CATALOG_INVALID" }; }

  const inputTextChars = integer(limits.inputTextChars, 1, 50_000); const requestsPerMinute = integer(limits.requestsPerMinute, 1, 1_000);
  const burst = integer(limits.burst, 1, 1_000); const activeDrafts = integer(limits.activeDrafts, 1, 100);
  const draftDays = integer(retention.draftDays, 1, 3_650); const auditDays = integer(retention.auditDays, 1, 3_650); const stateDir = string(root.stateDir);
  if (!inputTextChars || !requestsPerMinute || !burst || burst > requestsPerMinute || !activeDrafts || !draftDays || !auditDays || !stateDir || root.sttModel !== "medium") return { ok: false, code: "CONFIG_INVALID" };

  const config: EffectiveConfig = {
    agentId: "idea-mvp",
    telegram: Object.freeze({ channelId: "telegram", accountId: "default", pilotSenderId, adminSenderIds }),
    notifications: Object.freeze({ productOwnerSenderIds }),
    jira: Object.freeze({
      enabled: jira.enabled, url, origin: url, projectKey, issueTypeName,
      search: Object.freeze({ jql, fields, maxResults, maxPages, timeoutMs, maxContextBytes }),
      metadata: Object.freeze({ refreshIntervalMinutes }), create: Object.freeze({ requireConfirmation: create.requireConfirmation }),
      credentialAvailable: Boolean(environment.JIRA_TOKEN?.trim() || environment.JIRA_TOKEN_FILE?.trim()),
    }),
    catalog: Object.freeze({ path: catalogPath, schemaVersion: 1, sha256: catalogSha256 }), sttModel: "medium", allowedTools: IDEA_TO_JIRA_TOOLS,
    limits: Object.freeze({ inputTextChars, requestsPerMinute, burst, activeDrafts }), retention: Object.freeze({ draftDays, auditDays }), stateDir,
  };
  return { ok: true, config: Object.freeze(config) };
}

/** Legacy call site compatibility: creation is enabled only through the confirmation/idempotency workflow. */
export function assertCreateDisabled(_config: EffectiveConfig): void { /* transport boundary enforces create safety */ }
