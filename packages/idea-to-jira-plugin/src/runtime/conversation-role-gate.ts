import {
  authorizeConversationStatus,
  type ConversationAccessDecision,
  type UserAccessStatus,
} from "../access/access-service.js";
import type { EffectiveConfig } from "../config.js";
import type { TrustedRequesterContext } from "./requester-context.js";

export const CONVERSATION_ROLE_REPLIES = Object.freeze({
  GUEST: "У вас пока нет роли Creator. Чтобы запросить доступ, отправьте команду /request_access.",
  PENDING: "Запрос на роль Creator уже отправлен и ожидает решения. Команда /request_access покажет текущий статус.",
  SUSPENDED: "Роль Creator временно приостановлена. Команда /request_access покажет текущий статус.",
  BLOCKED: "Доступ к сервису ограничен.",
  UNAVAILABLE: "Не удалось проверить доступ. Попробуйте позже.",
});

export type ConversationRoleDecision =
  | {
      readonly allowed: true;
      readonly code: "ACTIVE_CREATOR" | "BUSINESS_ADMIN";
    }
  | {
      readonly allowed: false;
      readonly code: "GUEST" | "PENDING" | "SUSPENDED" | "BLOCKED" | "ROLE_STALE";
      readonly message: string;
    };

/**
 * Pure server-side role policy. BLOCKED overrides the independent
 * Business Admin capability; a CREATOR label is accepted only with an ACTIVE
 * grant in the same transactional status snapshot.
 */
export function decideConversationRoleAccess(
  requester: TrustedRequesterContext,
  status: UserAccessStatus,
  config: EffectiveConfig,
): ConversationRoleDecision {
  return presentConversationAccess(authorizeConversationStatus(requester, status, config));
}

function presentConversationAccess(decision: ConversationAccessDecision): ConversationRoleDecision {
  if (decision.allowed) return { allowed: true, code: decision.via };
  return {
    allowed: false,
    code: decision.state,
    message: decision.state === "ROLE_STALE"
      ? CONVERSATION_ROLE_REPLIES.UNAVAILABLE
      : CONVERSATION_ROLE_REPLIES[decision.state],
  };
}
