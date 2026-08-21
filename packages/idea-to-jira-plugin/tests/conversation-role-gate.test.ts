import assert from "node:assert/strict";
import test from "node:test";

import type { UserAccessStatus } from "../src/access/access-service.js";
import type { EffectiveConfig } from "../src/config.js";
import {
  CONVERSATION_ROLE_REPLIES,
  decideConversationRoleAccess,
} from "../src/runtime/conversation-role-gate.js";
import type { TrustedRequesterContext } from "../src/runtime/requester-context.js";

const requester: TrustedRequesterContext = Object.freeze({
  agentId: "idea-mvp",
  channelId: "telegram",
  accountId: "default",
  senderId: "123456789",
  chatId: "123456789",
});

function config(adminSenderIds: readonly string[] = []): EffectiveConfig {
  return {
    agentId: "idea-mvp",
    telegram: {
      channelId: "telegram",
      accountId: "default",
      pilotSenderId: requester.senderId,
      adminSenderIds,
    },
  } as EffectiveConfig;
}

function status(
  userState: UserAccessStatus["userState"],
  roleState?: NonNullable<UserAccessStatus["role"]>["state"],
): UserAccessStatus {
  return {
    userRef: "user_ref",
    userState,
    userVersion: 1,
    ...(roleState
      ? { role: { grantRef: "grant_ref", state: roleState, version: 1 } }
      : {}),
  };
}

test("active Creator is admitted to model conversation", () => {
  assert.deepEqual(
    decideConversationRoleAccess(requester, status("CREATOR", "ACTIVE"), config()),
    { allowed: true, code: "ACTIVE_CREATOR" },
  );
});

test("non-blocked Business Admin is admitted independently of user role", () => {
  assert.deepEqual(
    decideConversationRoleAccess(requester, status("GUEST"), config([requester.senderId])),
    { allowed: true, code: "BUSINESS_ADMIN" },
  );
});

test("non-admitted lifecycle states receive exact fixed replies", () => {
  const cases = [
    ["GUEST", CONVERSATION_ROLE_REPLIES.GUEST],
    ["PENDING", CONVERSATION_ROLE_REPLIES.PENDING],
    ["SUSPENDED", CONVERSATION_ROLE_REPLIES.SUSPENDED],
    ["BLOCKED", CONVERSATION_ROLE_REPLIES.BLOCKED],
  ] as const;

  for (const [userState, message] of cases) {
    assert.deepEqual(decideConversationRoleAccess(requester, status(userState), config()), {
      allowed: false,
      code: userState,
      message,
    });
  }
});

test("BLOCKED overrides Business Admin", () => {
  assert.deepEqual(
    decideConversationRoleAccess(requester, status("BLOCKED"), config([requester.senderId])),
    { allowed: false, code: "BLOCKED", message: CONVERSATION_ROLE_REPLIES.BLOCKED },
  );
});

test("Creator state without an active grant fails closed", () => {
  for (const roleState of [undefined, "SUSPENDED", "REVOKED"] as const) {
    assert.deepEqual(decideConversationRoleAccess(requester, status("CREATOR", roleState), config()), {
      allowed: false,
      code: "ROLE_STALE",
      message: CONVERSATION_ROLE_REPLIES.UNAVAILABLE,
    });
  }
});
