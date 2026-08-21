import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const IDEA_TO_JIRA_TOOLS = Object.freeze([
  "idea_to_jira_create_draft",
  "idea_to_jira_read_draft",
  "idea_to_jira_patch_draft",
  "idea_to_jira_cancel_draft",
  "idea_to_jira_request_access",
] as const);
export type IdeaToJiraToolName = (typeof IDEA_TO_JIRA_TOOLS)[number];
export const FIXED_JIRA_SCOPE = Object.freeze({
  projectKey: "FPF",
  projectId: "18100",
  issueTypeName: "Feature",
  issueTypeId: "11500",
});

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

export interface EffectiveConfig {
  readonly agentId: "idea-mvp";
  readonly telegram: {
    readonly channelId: "telegram";
    readonly accountId: "idea-mvp";
    readonly pilotSenderId: string;
    readonly adminSenderIds: readonly string[];
  };
  readonly notifications: {
    readonly productOwnerSenderIds: readonly string[];
  };
  readonly jira: {
    readonly origin: string;
    readonly tokenEnv: string;
    readonly projectKey: "FPF";
    readonly projectId: "18100";
    readonly issueTypeName: "Feature";
    readonly issueTypeId: "11500";
    readonly writeMode: "disabled";
  };
  readonly catalog: {
    readonly path: string;
    readonly schemaVersion: 1;
    readonly sha256: string;
  };
  readonly sttModel: "medium";
  readonly allowedTools: readonly IdeaToJiraToolName[];
  readonly limits: {
    readonly inputTextChars: number;
    readonly requestsPerMinute: number;
    readonly burst: number;
    readonly activeDrafts: number;
  };
  readonly retention: {
    readonly draftDays: number;
    readonly auditDays: number;
  };
  readonly stateDir: string;
}

export type ConfigLoadResult =
  | { readonly ok: true; readonly config: EffectiveConfig }
  | { readonly ok: false; readonly code: ConfigErrorCode };

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type ReadTextFile = (path: string) => string;

type JsonObject = Record<string, unknown>;

const ROOT_KEYS = [
  "agentId",
  "telegram",
  "notifications",
  "jira",
  "catalog",
  "sttModel",
  "allowedTools",
  "limits",
  "retention",
  "stateDir",
] as const;
const TELEGRAM_KEYS = ["channelId", "accountId", "pilotSenderIdEnv", "adminSenderIdsEnv"] as const;
const NOTIFICATION_KEYS = ["productOwnerSenderIdsEnv"] as const;
const JIRA_KEYS = [
  "originEnv",
  "tokenEnv",
  "projectKey",
  "projectId",
  "issueTypeName",
  "issueTypeId",
  "writeMode",
] as const;
const CATALOG_KEYS = ["path", "schemaVersion", "sha256"] as const;
const LIMIT_KEYS = ["inputTextChars", "requestsPerMinute", "burst", "activeDrafts"] as const;
const RETENTION_KEYS = ["draftDays", "auditDays"] as const;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function numericTelegramId(value: string): boolean {
  return /^[1-9][0-9]{0,19}$/.test(value);
}

function parseTelegramIds(raw: string | undefined): readonly string[] | undefined {
  if (!raw?.trim()) return undefined;
  const ids = [...new Set(raw.split(",").map((item) => item.trim()))];
  return ids.length > 0 && ids.every(numericTelegramId) ? Object.freeze(ids) : undefined;
}

function parseHttpsOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function matchesFixedJiraScope(jira: JsonObject): boolean {
  return jira.projectKey === FIXED_JIRA_SCOPE.projectKey &&
    jira.projectId === FIXED_JIRA_SCOPE.projectId &&
    jira.issueTypeName === FIXED_JIRA_SCOPE.issueTypeName &&
    jira.issueTypeId === FIXED_JIRA_SCOPE.issueTypeId;
}

export function loadEffectiveConfig(
  rawConfig: unknown,
  environment: RuntimeEnvironment = process.env,
  readTextFile: ReadTextFile = (path) => readFileSync(path, "utf8"),
): ConfigLoadResult {
  const root = object(rawConfig);
  if (!root) return { ok: false, code: "CONFIG_INVALID" };

  const telegram = object(root.telegram);
  const jira = object(root.jira);
  const notifications = object(root.notifications);
  const catalog = object(root.catalog);
  const limits = object(root.limits);
  const retention = object(root.retention);
  if (!telegram || !jira || !notifications || !catalog || !limits || !retention) {
    return { ok: false, code: "CONFIG_INVALID" };
  }
  if (
    !hasExactKeys(root, ROOT_KEYS) ||
    !hasExactKeys(telegram, TELEGRAM_KEYS) ||
    !hasExactKeys(notifications, NOTIFICATION_KEYS) ||
    !hasExactKeys(jira, JIRA_KEYS) ||
    !hasExactKeys(catalog, CATALOG_KEYS) ||
    !hasExactKeys(limits, LIMIT_KEYS) ||
    !hasExactKeys(retention, RETENTION_KEYS)
  ) {
    return { ok: false, code: "CONFIG_INVALID" };
  }

  if (
    root.agentId !== "idea-mvp" ||
    telegram.channelId !== "telegram" ||
    telegram.accountId !== "idea-mvp"
  ) {
    return { ok: false, code: "CHANNEL_BINDING_INVALID" };
  }

  if (!matchesFixedJiraScope(jira)) return { ok: false, code: "JIRA_SCOPE_INVALID" };
  if (jira.writeMode !== "disabled") return { ok: false, code: "CREATE_GATE_INVALID" };

  const allowedTools = root.allowedTools;
  if (
    !Array.isArray(allowedTools) ||
    allowedTools.length !== IDEA_TO_JIRA_TOOLS.length ||
    allowedTools.some((tool, index) => tool !== IDEA_TO_JIRA_TOOLS[index])
  ) {
    return { ok: false, code: "TOOL_ALLOWLIST_INVALID" };
  }

  const originEnv = string(jira.originEnv);
  const tokenEnv = string(jira.tokenEnv);
  const pilotSenderIdEnv = string(telegram.pilotSenderIdEnv);
  const adminsEnv = string(telegram.adminSenderIdsEnv);
  const productOwnerRoutesEnv = string(notifications.productOwnerSenderIdsEnv);
  if (
    originEnv !== "JIRA_BASE_URL" ||
    tokenEnv !== "JIRA_TOKEN" ||
    pilotSenderIdEnv !== "TELEGRAM_PILOT_SENDER_ID" ||
    adminsEnv !== "BUSINESS_ADMIN_TELEGRAM_IDS" ||
    productOwnerRoutesEnv !== "PRODUCT_OWNER_TELEGRAM_IDS"
  ) {
    return { ok: false, code: "CONFIG_INVALID" };
  }

  const origin = parseHttpsOrigin(environment[originEnv]);
  const pilotSenderId = string(environment[pilotSenderIdEnv]);
  const adminSenderIds = parseTelegramIds(environment[adminsEnv]);
  const productOwnerSenderIds = parseTelegramIds(environment[productOwnerRoutesEnv]);
  if (!origin || !pilotSenderId || !numericTelegramId(pilotSenderId) || !adminSenderIds || !productOwnerSenderIds) {
    return { ok: false, code: "SECRET_REF_MISSING" };
  }
  if (!adminSenderIds.includes(pilotSenderId)) return { ok: false, code: "CONFIG_INVALID" };

  const catalogPath = string(catalog.path);
  const catalogSha256 = string(catalog.sha256)?.toLowerCase();
  if (
    !catalogPath ||
    catalog.schemaVersion !== 1 ||
    !catalogSha256 ||
    !/^[a-f0-9]{64}$/.test(catalogSha256)
  ) {
    return { ok: false, code: "CATALOG_INVALID" };
  }
  try {
    const actual = createHash("sha256").update(readTextFile(catalogPath)).digest("hex");
    if (actual !== catalogSha256) return { ok: false, code: "CATALOG_INVALID" };
  } catch {
    return { ok: false, code: "CATALOG_INVALID" };
  }

  const inputTextChars = integer(limits.inputTextChars, 1, 50_000);
  const requestsPerMinute = integer(limits.requestsPerMinute, 1, 1_000);
  const burst = integer(limits.burst, 1, 1_000);
  const activeDrafts = integer(limits.activeDrafts, 1, 100);
  const draftDays = integer(retention.draftDays, 1, 3_650);
  const auditDays = integer(retention.auditDays, 1, 3_650);
  const stateDir = string(root.stateDir);
  if (!inputTextChars || !requestsPerMinute || !burst || burst > requestsPerMinute || !activeDrafts || !draftDays || !auditDays || !stateDir) {
    return { ok: false, code: "CONFIG_INVALID" };
  }
  if (root.sttModel !== "medium") return { ok: false, code: "CONFIG_INVALID" };

  return {
    ok: true,
    config: Object.freeze({
      agentId: "idea-mvp",
      telegram: Object.freeze({
        channelId: "telegram",
        accountId: "idea-mvp",
        pilotSenderId,
        adminSenderIds,
      }),
      notifications: Object.freeze({ productOwnerSenderIds }),
      jira: Object.freeze({
        origin,
        tokenEnv,
        ...FIXED_JIRA_SCOPE,
        writeMode: "disabled",
      }),
      catalog: Object.freeze({ path: catalogPath, schemaVersion: 1, sha256: catalogSha256 }),
      sttModel: "medium",
      allowedTools: IDEA_TO_JIRA_TOOLS,
      limits: Object.freeze({ inputTextChars, requestsPerMinute, burst, activeDrafts }),
      retention: Object.freeze({ draftDays, auditDays }),
      stateDir,
    }),
  };
}

export function assertCreateDisabled(config: EffectiveConfig): void {
  if (config.jira.writeMode !== "disabled") {
    throw new Error("CREATE_DISABLED");
  }
}
