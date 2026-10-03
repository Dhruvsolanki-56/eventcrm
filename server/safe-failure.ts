const safeCodes = new Set([
  'EAUTH', 'ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'EENVELOPE', 'EHOSTUNREACH',
  'EMESSAGE', 'ENETUNREACH', 'ESOCKET', 'ETIMEDOUT', 'EAI_AGAIN', 'EDNS',
]);

export const serverCardReaderUnavailableMessage = 'Server reading is off. Open Review to try on-device reading, or type it in.';

export function safeFailureCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return 'PROVIDER_ERROR';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && safeCodes.has(code) ? code : 'PROVIDER_ERROR';
}

export function safeJobFailureMessage(type: string): string {
  switch (type) {
    case 'email_send':
    case 'daily_digest':
    case 'password_reset_email':
    case 'email_verification':
      return 'The mail server could not accept this message.';
    case 'card_read':
      return 'Card reading did not finish on the server. Open Review to try on-device reading, or type it in.';
    case 'email_draft':
      return 'AI could not improve this draft. The editable template remains saved and unsent.';
    default:
      return 'This background task did not finish. Try again or contact your admin.';
  }
}
