import type { IdeaInput } from "../domain/idea.js";
import type { TrustedRequesterContext } from "../runtime/requester-context.js";
import type { DraftServiceResult, IdeaToJiraDraftService } from "./draft-service.js";

/** Legacy intake boundary now persists a real owned Draft; it never reports false READY. */
export function validateDraftForRequester(
  requester: TrustedRequesterContext,
  input: IdeaInput,
  service: IdeaToJiraDraftService,
): DraftServiceResult {
  if (requester.senderId !== requester.chatId) throw new Error("DESTINATION_DENIED");
  return service.createDraft(requester, input);
}
