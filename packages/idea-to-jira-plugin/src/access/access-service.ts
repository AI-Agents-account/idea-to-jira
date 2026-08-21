import { randomBytes, randomUUID } from "node:crypto";

import {
  authorizeActiveCreator,
  authorizeBusinessAdmin,
  authorizeOwnResource,
  type AuthorizationDecision,
  type AuthorizationSubject,
  type CreatorGrantSnapshot,
  type RoleGrantState,
  type UserState,
} from "../auth/authorization.js";
import { createAuditEvent, hashAuditActorReference, SqliteAuditWriter } from "../audit/index.js";
import type { EffectiveConfig } from "../config.js";
import { SafeError } from "../errors/index.js";
import type { TrustedRequesterContext } from "../runtime/requester-context.js";
import type { StorageUnitOfWork } from "../storage/repository.js";
import type { SqlExecutor } from "../storage/transaction.js";

export interface UntrustedIdentitySnapshot {
  readonly username?: string;
  readonly displayName?: string;
}

interface UserRow {
  readonly id: string;
  readonly telegram_sender_id: string;
  readonly username_snapshot: string | null;
  readonly display_name_snapshot: string | null;
  readonly state: UserState;
  readonly record_version: number;
}

interface AccessRequestRow {
  readonly id: string;
  readonly user_id: string;
  readonly action_ref: string | null;
  readonly state: "PENDING" | "APPROVED" | "DENIED" | "BLOCKED" | "CANCELLED";
  readonly record_version: number;
  readonly requested_at: string;
  readonly decided_at: string | null;
}

interface AdminAccessRequestRow extends AccessRequestRow {
  readonly telegram_sender_id: string;
  readonly username_snapshot: string | null;
  readonly display_name_snapshot: string | null;
  readonly user_state: UserState;
  readonly user_record_version: number;
}

interface RoleGrantRow {
  readonly id: string;
  readonly user_id: string;
  readonly role: "CREATOR";
  readonly state: RoleGrantState;
  readonly record_version: number;
  readonly user_state: UserState;
  readonly user_record_version: number;
  readonly telegram_sender_id: string;
}

interface DraftAuthorizationRow {
  readonly owner_user_id: string;
  readonly user_id: string;
  readonly telegram_sender_id: string;
  readonly user_state: UserState;
  readonly grant_state: RoleGrantState | null;
  readonly grant_version: number | null;
}

export interface UserAccessStatus {
  readonly userRef: string;
  readonly userState: UserState;
  readonly userVersion: number;
  readonly request?: {
    readonly requestRef: string;
    readonly actionRef: string;
    readonly state: AccessRequestRow["state"];
    readonly version: number;
  };
  readonly role?: {
    readonly grantRef: string;
    readonly state: RoleGrantState;
    readonly version: number;
  };
}

export interface AccessRequestSubmission {
  readonly created: boolean;
  readonly status: UserAccessStatus;
  readonly adminCard?: AdminAccessRequestCard;
}

export interface AdminAccessRequestCard {
  readonly senderId: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly actionRef: string;
  readonly version: number;
}

export type AccessDecision = "APPROVE" | "DENY" | "BLOCK";
export type RoleTransition = "SUSPEND" | "RESTORE" | "REVOKE" | "BLOCK";

export interface AccessDecisionResult {
  readonly requestRef: string;
  readonly requestState: "APPROVED" | "DENIED" | "BLOCKED";
  readonly requestVersion: number;
  readonly userRef: string;
  readonly userState: UserState;
  readonly userVersion: number;
  readonly role?: {
    readonly grantRef: string;
    readonly state: "ACTIVE";
    readonly version: 1;
  };
}

export interface RoleTransitionResult {
  readonly grantRef: string;
  readonly grantState: RoleGrantState;
  readonly grantVersion: number;
  readonly userRef: string;
  readonly userState: UserState;
  readonly userVersion: number;
}

export interface AccessServiceOptions {
  readonly unitOfWork: StorageUnitOfWork;
  readonly config: EffectiveConfig;
  readonly auditWriter?: SqliteAuditWriter;
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly newActionRef?: () => string;
}

function sanitizeSnapshot(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, maxLength);
}

function sanitizeReason(reason: string | undefined, fallback: string): string {
  const normalized = sanitizeSnapshot(reason, 256);
  return normalized ?? fallback;
}

function changed(result: { readonly changes: number | bigint }): boolean {
  return Number(result.changes) === 1;
}

function requireActionRef(value: string | null): string {
  if (!value || !/^[A-Za-z0-9_-]{20,64}$/.test(value)) {
    throw new SafeError("ACCESS_REQUEST_CONFLICT", false);
  }
  return value;
}

function subjectFromDraft(row: DraftAuthorizationRow | undefined): AuthorizationSubject | undefined {
  return row
    ? {
        userId: row.user_id,
        senderId: row.telegram_sender_id,
        state: row.user_state,
      }
    : undefined;
}

function grantFromDraft(row: DraftAuthorizationRow | undefined): CreatorGrantSnapshot | undefined {
  return row?.grant_state && row.grant_version !== null
    ? {
        role: "CREATOR",
        state: row.grant_state,
        recordVersion: row.grant_version,
      }
    : undefined;
}

export class AccessService {
  private readonly audit: SqliteAuditWriter;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly newActionRef: () => string;

  constructor(private readonly options: AccessServiceOptions) {
    this.audit = options.auditWriter ?? new SqliteAuditWriter();
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
    this.newActionRef = options.newActionRef ?? (() => randomBytes(24).toString("base64url"));
  }

  ensureUser(
    requester: TrustedRequesterContext,
    snapshot: UntrustedIdentitySnapshot = {},
  ): UserAccessStatus {
    return this.options.unitOfWork.criticalTransaction(({ sql }) => {
      const user = this.ensureUserRow(sql, requester, snapshot);
      return this.statusForUser(sql, user);
    });
  }

  getStatus(requester: TrustedRequesterContext): UserAccessStatus {
    return this.options.unitOfWork.transaction(({ sql }) => {
      const user = this.findUserBySender(sql, requester.senderId);
      if (!user) throw new SafeError("ACCESS_DENIED", false);
      return this.statusForUser(sql, user);
    });
  }

  requestAccess(
    requester: TrustedRequesterContext,
    snapshot: UntrustedIdentitySnapshot = {},
  ): AccessRequestSubmission {
    return this.options.unitOfWork.criticalTransaction(({ sql }) => {
      const user = this.ensureUserRow(sql, requester, snapshot);
      if (user.state === "BLOCKED") throw new SafeError("ACCESS_DENIED", false);
      if (user.state === "PENDING") {
        const status = this.statusForUser(sql, user);
        if (!status.request || status.request.state !== "PENDING") {
          throw new SafeError("ACCESS_REQUEST_CONFLICT", false);
        }
        return Object.freeze({ created: false, status });
      }
      if (user.state === "CREATOR" || user.state === "SUSPENDED") {
        return Object.freeze({ created: false, status: this.statusForUser(sql, user) });
      }
      if (user.state !== "GUEST") throw new SafeError("ACCESS_REQUEST_CONFLICT", false);

      const requestId = this.newId();
      const actionRef = this.newActionRef();
      const occurredAt = this.now();
      if (!changed(sql.prepare(`
        UPDATE users
        SET state = 'PENDING', record_version = record_version + 1, updated_at = ?
        WHERE id = ? AND state = 'GUEST' AND record_version = ?
      `).run(occurredAt, user.id, user.record_version))) {
        throw new SafeError("ACCESS_REQUEST_CONFLICT", true);
      }
      sql.prepare(`
        INSERT INTO access_requests(id, user_id, requested_at, action_ref)
        VALUES (?, ?, ?, ?)
      `).run(requestId, user.id, occurredAt, actionRef);
      this.audit.append(sql, createAuditEvent({
        occurredAt,
        actor: {
          kind: "USER",
          userId: user.id,
          refHash: hashAuditActorReference(requester.accountId, requester.senderId),
        },
        action: "ACCESS_DECISION",
        target: { type: "ACCESS_REQUEST", id: requestId },
        outcome: "SUCCEEDED",
        code: "ACCESS_REQUESTED",
        links: { requestId },
        retentionClass: "AUDIT_1Y",
      }));

      const updated = this.requireUserById(sql, user.id);
      const status = this.statusForUser(sql, updated);
      return Object.freeze({
        created: true,
        status,
        adminCard: Object.freeze({
          senderId: user.telegram_sender_id,
          ...(user.username_snapshot ? { username: user.username_snapshot } : {}),
          ...(user.display_name_snapshot ? { displayName: user.display_name_snapshot } : {}),
          actionRef,
          version: 1,
        }),
      });
    });
  }

  decideAccess(
    admin: TrustedRequesterContext,
    input: {
      readonly actionRef: string;
      readonly expectedVersion: number;
      readonly decision: AccessDecision;
      readonly reason?: string;
    },
  ): AccessDecisionResult {
    this.requireAdmin(admin);
    return this.options.unitOfWork.criticalTransaction(({ sql }) => {
      const adminUser = this.ensureUserRow(sql, admin, {});
      const request = sql.prepare(`
        SELECT ar.id, ar.user_id, ar.action_ref, ar.state, ar.record_version,
               ar.requested_at, ar.decided_at, u.telegram_sender_id,
               u.username_snapshot, u.display_name_snapshot, u.state AS user_state,
               u.record_version AS user_record_version
        FROM access_requests ar
        JOIN users u ON u.id = ar.user_id
        WHERE ar.action_ref = ?
      `).get(input.actionRef) as AdminAccessRequestRow | undefined;
      if (!request || request.state !== "PENDING" || request.record_version !== input.expectedVersion) {
        throw new SafeError("ACCESS_REQUEST_STALE", false);
      }
      if (request.user_state !== "PENDING") throw new SafeError("ACCESS_REQUEST_CONFLICT", false);

      const occurredAt = this.now();
      const nextRequestState = input.decision === "APPROVE"
        ? "APPROVED"
        : input.decision === "DENY"
          ? "DENIED"
          : "BLOCKED";
      const nextUserState: UserState = input.decision === "APPROVE"
        ? "CREATOR"
        : input.decision === "DENY"
          ? "GUEST"
          : "BLOCKED";
      const reason = sanitizeReason(input.reason, `ADMIN_${input.decision}`);

      if (!changed(sql.prepare(`
        UPDATE access_requests
        SET state = ?, decided_by_user_id = ?, decided_at = ?, decision_code = ?,
            decision_reason = ?, record_version = record_version + 1
        WHERE id = ? AND state = 'PENDING' AND record_version = ?
      `).run(
        nextRequestState,
        adminUser.id,
        occurredAt,
        `ACCESS_${nextRequestState}`,
        reason,
        request.id,
        input.expectedVersion,
      ))) throw new SafeError("ACCESS_REQUEST_STALE", false);

      if (!changed(sql.prepare(`
        UPDATE users
        SET state = ?, record_version = record_version + 1, updated_at = ?
        WHERE id = ? AND state = 'PENDING' AND record_version = ?
      `).run(nextUserState, occurredAt, request.user_id, request.user_record_version))) {
        throw new SafeError("ACCESS_REQUEST_STALE", false);
      }

      let role: AccessDecisionResult["role"];
      if (input.decision === "APPROVE") {
        const grantRef = this.newId();
        sql.prepare(`
          INSERT INTO role_grants(
            id, user_id, role, state, granted_by_user_id, granted_at,
            decision_code, transition_reason
          ) VALUES (?, ?, 'CREATOR', 'ACTIVE', ?, ?, 'ACCESS_APPROVED', ?)
        `).run(grantRef, request.user_id, adminUser.id, occurredAt, reason);
        role = Object.freeze({ grantRef, state: "ACTIVE", version: 1 });
        this.audit.append(sql, createAuditEvent({
          occurredAt,
          actor: { kind: "USER", userId: adminUser.id },
          action: "ROLE_TRANSITION",
          target: { type: "ROLE_GRANT", id: grantRef },
          outcome: "SUCCEEDED",
          code: "CREATOR_GRANTED",
          links: { requestId: request.id },
          retentionClass: "AUDIT_1Y",
        }));
      }

      this.audit.append(sql, createAuditEvent({
        occurredAt,
        actor: { kind: "USER", userId: adminUser.id },
        action: "ACCESS_DECISION",
        target: { type: "ACCESS_REQUEST", id: request.id },
        outcome: "SUCCEEDED",
        code: `ACCESS_${nextRequestState}`,
        links: { requestId: request.id },
        retentionClass: "AUDIT_1Y",
      }));

      return Object.freeze({
        requestRef: request.id,
        requestState: nextRequestState,
        requestVersion: request.record_version + 1,
        userRef: request.user_id,
        userState: nextUserState,
        userVersion: request.user_record_version + 1,
        ...(role ? { role } : {}),
      });
    });
  }

  transitionRole(
    admin: TrustedRequesterContext,
    input: {
      readonly grantRef: string;
      readonly expectedVersion: number;
      readonly transition: RoleTransition;
      readonly reason?: string;
    },
  ): RoleTransitionResult {
    this.requireAdmin(admin);
    return this.options.unitOfWork.criticalTransaction(({ sql }) => {
      const adminUser = this.ensureUserRow(sql, admin, {});
      const grant = sql.prepare(`
        SELECT rg.id, rg.user_id, rg.role, rg.state, rg.record_version,
               u.state AS user_state, u.record_version AS user_record_version,
               u.telegram_sender_id
        FROM role_grants rg
        JOIN users u ON u.id = rg.user_id
        WHERE rg.id = ? AND rg.role = 'CREATOR'
      `).get(input.grantRef) as RoleGrantRow | undefined;
      if (!grant || grant.record_version !== input.expectedVersion) {
        throw new SafeError("ROLE_STALE", false);
      }

      const transition = this.resolveRoleTransition(grant, input.transition);
      const occurredAt = this.now();
      const reason = sanitizeReason(input.reason, `ADMIN_${input.transition}`);
      if (!changed(sql.prepare(`
        UPDATE role_grants
        SET state = ?, record_version = record_version + 1,
            ended_at = CASE WHEN ? = 'ACTIVE' THEN NULL ELSE ? END,
            decision_code = ?, transition_reason = ?
        WHERE id = ? AND state = ? AND record_version = ?
      `).run(
        transition.grantState,
        transition.grantState,
        occurredAt,
        `ADMIN_${input.transition}`,
        reason,
        grant.id,
        grant.state,
        input.expectedVersion,
      ))) throw new SafeError("ROLE_STALE", false);

      if (!changed(sql.prepare(`
        UPDATE users
        SET state = ?, record_version = record_version + 1, updated_at = ?
        WHERE id = ? AND state = ? AND record_version = ?
      `).run(
        transition.userState,
        occurredAt,
        grant.user_id,
        grant.user_state,
        grant.user_record_version,
      ))) throw new SafeError("ROLE_STALE", false);

      this.audit.append(sql, createAuditEvent({
        occurredAt,
        actor: { kind: "USER", userId: adminUser.id },
        action: "ROLE_TRANSITION",
        target: { type: "ROLE_GRANT", id: grant.id },
        outcome: "SUCCEEDED",
        code: `CREATOR_${input.transition === "BLOCK" ? "BLOCKED" : input.transition}`,
        links: {},
        retentionClass: "AUDIT_1Y",
      }));

      return Object.freeze({
        grantRef: grant.id,
        grantState: transition.grantState,
        grantVersion: grant.record_version + 1,
        userRef: grant.user_id,
        userState: transition.userState,
        userVersion: grant.user_record_version + 1,
      });
    });
  }

  unblockUser(
    admin: TrustedRequesterContext,
    input: { readonly userRef: string; readonly expectedVersion: number },
  ): UserAccessStatus {
    this.requireAdmin(admin);
    return this.options.unitOfWork.criticalTransaction(({ sql }) => {
      const adminUser = this.ensureUserRow(sql, admin, {});
      const user = this.requireUserById(sql, input.userRef);
      if (user.state !== "BLOCKED" || user.record_version !== input.expectedVersion) {
        throw new SafeError("ROLE_STALE", false);
      }
      const occurredAt = this.now();
      if (!changed(sql.prepare(`
        UPDATE users
        SET state = 'GUEST', record_version = record_version + 1, updated_at = ?
        WHERE id = ? AND state = 'BLOCKED' AND record_version = ?
      `).run(occurredAt, user.id, input.expectedVersion))) {
        throw new SafeError("ROLE_STALE", false);
      }
      this.audit.append(sql, createAuditEvent({
        occurredAt,
        actor: { kind: "USER", userId: adminUser.id },
        action: "ROLE_TRANSITION",
        target: { type: "ROLE_GRANT", id: user.id },
        outcome: "SUCCEEDED",
        code: "USER_UNBLOCKED",
        links: {},
        retentionClass: "AUDIT_1Y",
      }));
      return this.statusForUser(sql, this.requireUserById(sql, user.id));
    });
  }

  authorizeOwnDraft(requester: TrustedRequesterContext, draftId: string): AuthorizationDecision {
    return this.options.unitOfWork.transaction(({ sql }) => {
      const row = this.readDraftAuthorization(sql, requester.senderId, draftId);
      return authorizeOwnResource(requester, subjectFromDraft(row), row?.owner_user_id);
    });
  }

  authorizeCreatorOperation(requester: TrustedRequesterContext, draftId: string): AuthorizationDecision {
    return this.options.unitOfWork.transaction(({ sql }) => {
      const row = this.readDraftAuthorization(sql, requester.senderId, draftId);
      const owner = authorizeOwnResource(requester, subjectFromDraft(row), row?.owner_user_id);
      if (!owner.allowed) return owner;
      return authorizeActiveCreator(requester, subjectFromDraft(row), grantFromDraft(row));
    });
  }

  private requireAdmin(requester: TrustedRequesterContext): void {
    if (!authorizeBusinessAdmin(requester, this.options.config).allowed) {
      throw new SafeError("ACCESS_DENIED", false);
    }
  }

  private ensureUserRow(
    sql: SqlExecutor,
    requester: TrustedRequesterContext,
    snapshot: UntrustedIdentitySnapshot,
  ): UserRow {
    const existing = this.findUserBySender(sql, requester.senderId);
    if (existing) return existing;
    const username = sanitizeSnapshot(snapshot.username, 64) ?? null;
    const displayName = sanitizeSnapshot(snapshot.displayName, 256) ?? null;
    sql.prepare(`
      INSERT OR IGNORE INTO users(
        id, telegram_sender_id, username_snapshot, display_name_snapshot
      ) VALUES (?, ?, ?, ?)
    `).run(this.newId(), requester.senderId, username, displayName);
    const created = this.findUserBySender(sql, requester.senderId);
    if (!created) throw new SafeError("ACCESS_REQUEST_CONFLICT", true);
    return created;
  }

  private findUserBySender(sql: SqlExecutor, senderId: string): UserRow | undefined {
    return sql.prepare(`
      SELECT id, telegram_sender_id, username_snapshot, display_name_snapshot,
             state, record_version
      FROM users WHERE telegram_sender_id = ?
    `).get(senderId) as UserRow | undefined;
  }

  private requireUserById(sql: SqlExecutor, userId: string): UserRow {
    const row = sql.prepare(`
      SELECT id, telegram_sender_id, username_snapshot, display_name_snapshot,
             state, record_version
      FROM users WHERE id = ?
    `).get(userId) as UserRow | undefined;
    if (!row) throw new SafeError("ACCESS_DENIED", false);
    return row;
  }

  private statusForUser(sql: SqlExecutor, user: UserRow): UserAccessStatus {
    const request = sql.prepare(`
      SELECT id, user_id, action_ref, state, record_version, requested_at, decided_at
      FROM access_requests
      WHERE user_id = ?
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `).get(user.id) as AccessRequestRow | undefined;
    const role = sql.prepare(`
      SELECT id, state, record_version
      FROM role_grants
      WHERE user_id = ? AND role = 'CREATOR' AND state IN ('ACTIVE', 'SUSPENDED')
      LIMIT 1
    `).get(user.id) as Pick<RoleGrantRow, "id" | "state" | "record_version"> | undefined;

    return Object.freeze({
      userRef: user.id,
      userState: user.state,
      userVersion: user.record_version,
      ...(request
        ? {
            request: Object.freeze({
              requestRef: request.id,
              actionRef: requireActionRef(request.action_ref),
              state: request.state,
              version: request.record_version,
            }),
          }
        : {}),
      ...(role
        ? {
            role: Object.freeze({
              grantRef: role.id,
              state: role.state,
              version: role.record_version,
            }),
          }
        : {}),
    });
  }

  private resolveRoleTransition(
    grant: RoleGrantRow,
    transition: RoleTransition,
  ): { readonly grantState: RoleGrantState; readonly userState: UserState } {
    if (transition === "SUSPEND" && grant.state === "ACTIVE" && grant.user_state === "CREATOR") {
      return { grantState: "SUSPENDED", userState: "SUSPENDED" };
    }
    if (transition === "RESTORE" && grant.state === "SUSPENDED" && grant.user_state === "SUSPENDED") {
      return { grantState: "ACTIVE", userState: "CREATOR" };
    }
    if (transition === "REVOKE" &&
        (grant.state === "ACTIVE" || grant.state === "SUSPENDED") &&
        (grant.user_state === "CREATOR" || grant.user_state === "SUSPENDED")) {
      return { grantState: "REVOKED", userState: "GUEST" };
    }
    if (transition === "BLOCK" &&
        (grant.state === "ACTIVE" || grant.state === "SUSPENDED") &&
        (grant.user_state === "CREATOR" || grant.user_state === "SUSPENDED")) {
      return { grantState: "REVOKED", userState: "BLOCKED" };
    }
    throw new SafeError("ROLE_STATE_INVALID", false);
  }

  private readDraftAuthorization(
    sql: SqlExecutor,
    senderId: string,
    draftId: string,
  ): DraftAuthorizationRow | undefined {
    return sql.prepare(`
      SELECT d.owner_user_id, u.id AS user_id, u.telegram_sender_id,
             u.state AS user_state, rg.state AS grant_state,
             rg.record_version AS grant_version
      FROM drafts d
      JOIN users u ON u.telegram_sender_id = ?
      LEFT JOIN role_grants rg
        ON rg.user_id = u.id AND rg.role = 'CREATOR' AND rg.state IN ('ACTIVE', 'SUSPENDED')
      WHERE d.id = ?
    `).get(senderId, draftId) as DraftAuthorizationRow | undefined;
  }
}

export function renderAdminAccessCard(card: AdminAccessRequestCard): string {
  return [
    "Access request",
    `Sender ID: ${card.senderId}`,
    ...(card.username ? [`Username snapshot: ${card.username}`] : []),
    ...(card.displayName ? [`Display name snapshot: ${card.displayName}`] : []),
    `Action reference: ${card.actionRef}`,
    `Version: ${card.version}`,
    "Commands: /access approve|deny|block <action-reference> <version>",
  ].join("\n");
}
