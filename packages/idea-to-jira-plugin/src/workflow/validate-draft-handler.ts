import type { IdeaInput, JiraIssueDraft } from "../domain/idea.js";
import type { TrustedRequesterContext } from "../runtime/requester-context.js";
import type { IdeaToJiraDraftService } from "./draft-service.js";

/** Business-handler boundary: trusted host identity is mandatory even for stateless stage-01 validation. */
export function validateDraftForRequester(
  requester: TrustedRequesterContext,
  input: IdeaInput,
  service: IdeaToJiraDraftService,
): JiraIssueDraft {
  // The identity is intentionally not copied into Draft/model output. Later peer-scoped persistence
  // must use this trusted value as its partition key rather than accepting an argument field.
  if (requester.senderId !== requester.chatId) throw new Error("DESTINATION_DENIED");
  return service.createDraft(input);
}
