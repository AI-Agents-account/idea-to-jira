import { createHash } from "node:crypto";

import type { EffectiveConfig } from "../config.js";
import { JiraHttpClient } from "./http-client.js";
import { buildCreateForm } from "./dynamic-fields.js";
import { JiraFailure, type JiraAllowedValue, type JiraFieldMetadata, type JiraMetadataSnapshot } from "./types.js";

type Json = Record<string, unknown>;
const MAX_METADATA_FIELDS = 256;
const MAX_ALLOWED_VALUES_PER_FIELD = 200;
const MAX_ALLOWED_VALUES_TOTAL = 1_000;
function record(value: unknown): Json | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined; }
function text(value: unknown, maximum = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean && clean.length <= maximum ? clean : undefined;
}
function runtimeId(value: unknown): string | undefined { const id = text(value); return id && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : undefined; }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Json).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function option(value: unknown): JiraAllowedValue | undefined {
  const item = record(value); const id = runtimeId(item?.id); const label = text(item?.value) ?? text(item?.name) ?? text(item?.label);
  return id && label ? Object.freeze({ id, label }) : undefined;
}
function field(id: string, value: unknown): JiraFieldMetadata | undefined {
  const item = record(value); const name = text(item?.name); const schema = record(item?.schema);
  const type = text(schema?.type);
  if (!name || !type || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(id)) return undefined;
  if (Array.isArray(item?.allowedValues) && item.allowedValues.length > MAX_ALLOWED_VALUES_PER_FIELD) return undefined;
  const allowed = Array.isArray(item?.allowedValues) ? item.allowedValues.map(option).filter((entry): entry is JiraAllowedValue => Boolean(entry)) : [];
  const items = text(schema?.items); const system = text(schema?.system); const custom = text(schema?.custom);
  return Object.freeze({
    id, name, required: item?.required === true,
    schema: Object.freeze({ type, ...(items ? { items } : {}), ...(system ? { system } : {}), ...(custom ? { custom } : {}) }),
    hasDefaultValue: Boolean(item && Object.hasOwn(item, "defaultValue") && item.defaultValue !== null),
    ...(item && Object.hasOwn(item, "defaultValue") ? { defaultValue: item.defaultValue } : {}),
    allowedValues: Object.freeze(allowed),
  });
}

export interface JiraMetadataClientOptions {
  readonly config: EffectiveConfig["jira"];
  readonly http: JiraHttpClient;
  readonly now?: () => Date;
}

export class JiraMetadataClient {
  private current?: JiraMetadataSnapshot;
  private refreshPromise: Promise<JiraMetadataSnapshot> | undefined;
  private readonly now: () => Date;
  constructor(private readonly options: JiraMetadataClientOptions) { this.now = options.now ?? (() => new Date()); }
  snapshot(): JiraMetadataSnapshot | undefined { return this.current; }
  stale(snapshot = this.current): boolean {
    if (!snapshot) return true;
    return this.now().getTime() - Date.parse(snapshot.fetchedAt) >= this.options.config.metadata.refreshIntervalMinutes * 60_000;
  }
  refresh(): Promise<JiraMetadataSnapshot> {
    this.refreshPromise ??= this.discover().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }
  async currentOrRefresh(): Promise<JiraMetadataSnapshot> { return !this.current || this.stale() ? this.refresh() : this.current; }

  private async discover(): Promise<JiraMetadataSnapshot> {
    if (!this.options.config.enabled) throw new JiraFailure("JIRA_DISABLED", true);
    const projectResponse = await this.options.http.read<unknown>(`/rest/api/2/project/${encodeURIComponent(this.options.config.projectKey)}`);
    const project = record(projectResponse.value); const projectId = runtimeId(project?.id); const projectKey = text(project?.key); const projectName = text(project?.name) ?? projectKey;
    if (!projectId || projectKey !== this.options.config.projectKey || !projectName) throw new JiraFailure("JIRA_SCOPE_NOT_FOUND");

    const metaPath = "/rest/api/2/issue/createmeta?" + new URLSearchParams({ projectKeys: this.options.config.projectKey, issuetypeNames: this.options.config.issueTypeName, expand: "projects.issuetypes.fields" });
    const metaResponse = await this.options.http.read<unknown>(metaPath);
    const meta = record(metaResponse.value); const projects = Array.isArray(meta?.projects) ? meta.projects : [];
    const selectedProject = projects.map(record).find((candidate) => text(candidate?.key) === this.options.config.projectKey);
    const issueTypes = Array.isArray(selectedProject?.issuetypes) ? selectedProject.issuetypes : [];
    const selectedType = issueTypes.map(record).find((candidate) => text(candidate?.name) === this.options.config.issueTypeName);
    const issueTypeId = runtimeId(selectedType?.id); const issueTypeName = text(selectedType?.name); const rawFields = record(selectedType?.fields);
    if (!issueTypeId || issueTypeName !== this.options.config.issueTypeName || !rawFields) throw new JiraFailure("JIRA_SCOPE_NOT_FOUND");
    const rawFieldEntries = Object.entries(rawFields);
    if (rawFieldEntries.length > MAX_METADATA_FIELDS) throw new JiraFailure("JIRA_RESPONSE_TOO_LARGE");
    const parsedFields: Array<[string, JiraFieldMetadata]> = [];
    for (const [id, value] of rawFieldEntries) {
      const parsed = field(id, value);
      if (parsed) parsedFields.push([id, parsed]);
      else if (record(value)?.required === true) throw new JiraFailure("JIRA_MALFORMED");
    }
    if (parsedFields.reduce((total, [, value]) => total + value.allowedValues.length, 0) > MAX_ALLOWED_VALUES_TOTAL) throw new JiraFailure("JIRA_RESPONSE_TOO_LARGE");
    const fields = Object.freeze(Object.fromEntries(parsedFields));

    const permissionPath = "/rest/api/2/mypermissions?" + new URLSearchParams({ projectKey: this.options.config.projectKey, permissions: "BROWSE_PROJECTS,CREATE_ISSUES" });
    const permissionResponse = await this.options.http.read<unknown>(permissionPath); const permissions = record(record(permissionResponse.value)?.permissions);
    const browse = record(permissions?.BROWSE_PROJECTS)?.havePermission === true; const create = record(permissions?.CREATE_ISSUES)?.havePermission === true;
    const preflight = await this.options.http.read<unknown>("/rest/api/2/search", "POST", Object.freeze({
      jql: this.options.config.search.jql, fields: this.options.config.search.fields, startAt: 0, maxResults: 1,
    }));
    const preflightBody = record(preflight.value);
    if (!Array.isArray(preflightBody?.issues) || typeof preflightBody.total !== "number" || !Number.isSafeInteger(preflightBody.total) || preflightBody.total < 0) throw new JiraFailure("JIRA_MALFORMED");
    const provisional = { project: { id: projectId, key: projectKey, name: projectName }, issueType: { id: issueTypeId, name: issueTypeName }, fields, permissions: { browse, create } };
    const form = buildCreateForm({ ...provisional, fetchedAt: "", hash: "", readiness: "JIRA_SEARCH_READY", blockers: [] });
    const blockers = [...form.blockers, ...(!browse ? ["BROWSE_PERMISSION_MISSING"] : []), ...(!create ? ["CREATE_PERMISSION_MISSING"] : [])];
    const readiness = !browse ? "JIRA_UNAVAILABLE" : create && blockers.length === 0 ? "JIRA_CREATE_READY" : "JIRA_SEARCH_READY";
    const hash = createHash("sha256").update(stable(provisional)).digest("hex");
    const snapshot: JiraMetadataSnapshot = Object.freeze({
      project: Object.freeze(provisional.project), issueType: Object.freeze(provisional.issueType), fields,
      permissions: Object.freeze({ browse, create }), fetchedAt: this.now().toISOString(), hash, readiness,
      blockers: Object.freeze(blockers),
    });
    this.current = snapshot;
    return snapshot;
  }
}
