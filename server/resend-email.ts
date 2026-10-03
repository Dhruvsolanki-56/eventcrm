export function leadMailTransportReady() {
  return process.env.EMAIL_TRANSPORT === 'resend'
    ? Boolean(process.env.RESEND_API_KEY?.trim())
    : Boolean(process.env.SMTP_HOST?.trim());
}

export async function sendResendEmail(input: {
  id: string; fromAddress: string; fromName: string; to: string;
  subject: string; text: string; unsubscribeUrl?: string;
}) {
  const key = process.env.RESEND_API_KEY?.trim();
  if (process.env.EMAIL_TRANSPORT !== 'resend' || !key) throw new Error('HTTPS email provider is not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': input.id,
    },
    body: JSON.stringify({
      from: `${input.fromName.replace(/[\r\n<>]/g, '').trim()} <${input.fromAddress}>`,
      to: [input.to], subject: input.subject, text: input.text,
      ...(input.unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${input.unsubscribeUrl}>` } } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTPS email provider did not accept the message (${response.status}).`);
  const body = await response.json() as { id?: unknown };
  if (typeof body.id !== 'string' || !body.id) throw new Error('HTTPS email provider did not return a message ID.');
  return body.id;
}
