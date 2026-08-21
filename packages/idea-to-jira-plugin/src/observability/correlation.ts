import { randomUUID } from "node:crypto";

declare const correlationBrand: unique symbol;
declare const requestBrand: unique symbol;
declare const draftBrand: unique symbol;
declare const operationBrand: unique symbol;
declare const notificationBrand: unique symbol;

export type CorrelationId = string & { readonly [correlationBrand]: true };
export type RequestId = string & { readonly [requestBrand]: true };
export type DraftId = string & { readonly [draftBrand]: true };
export type OperationId = string & { readonly [operationBrand]: true };
export type NotificationId = string & { readonly [notificationBrand]: true };

/** Local trace identity only. It is never a Jira key or Jira idempotency mechanism. */
export function newCorrelationId(): CorrelationId {
  return randomUUID() as CorrelationId;
}

export function newRequestId(): RequestId {
  return randomUUID() as RequestId;
}

export interface CorrelationContext {
  readonly correlationId: CorrelationId;
  readonly requestId: RequestId;
  readonly draftId?: DraftId;
  readonly operationId?: OperationId;
  readonly notificationId?: NotificationId;
}

export function createCorrelationContext(): CorrelationContext {
  return Object.freeze({ correlationId: newCorrelationId(), requestId: newRequestId() });
}
