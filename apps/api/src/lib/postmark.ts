import {
  sendEmail as sendEmailImpl,
  isEmailProviderConfigured,
  PermanentEmailError,
  type SendEmailInput,
} from "./email-service.js";

/**
 * Backwards-compatible facade over email-service.
 * `postmarkEnabled` means "emails really reach inboxes" (Postmark or Ethereal).
 */
export const postmarkEnabled = isEmailProviderConfigured();

export { PermanentEmailError };
export type { SendEmailInput };

export async function sendEmail(input: SendEmailInput): Promise<{ providerMsgId: string }> {
  const result = await sendEmailImpl(input);
  return { providerMsgId: result.providerMsgId };
}
