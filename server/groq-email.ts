import { z } from 'zod';
import { EMAIL_ATTEMPT_TIMEOUTS_MS, RetryableEmailError, emailWritingInstruction, plainTypography, rejectInternalNoteLanguage, tidyEmailBody, type EmailDraftContext } from './email-writing.js';

const GroqEmailSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
}).strict();

const MAX_RESPONSE_BYTES = 32 * 1024;

// Groq is an optional second writer for email drafts. It needs only its own key; photo reading stays with Gemini.
export const isGroqEmailEnabled = () => process.env.AI_MODE === 'provider' && Boolean(process.env.GROQ_API_KEY?.trim());

async function requestDraft(model: string, key: string, context: EmailDraftContext, alternate: boolean, timeoutMs: number) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: alternate ? 0.5 : 0.25,
      max_tokens: 2048,
      ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: emailWritingInstruction(alternate) },
        { role: 'user', content: JSON.stringify(context) },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error: unknown) => {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError)) throw new RetryableEmailError('AI email writing timed out.');
    throw error;
  });
  if (!response.ok) {
    if (response.status >= 500) throw new RetryableEmailError('AI email writing is unavailable.');
    throw new Error('AI email writing is unavailable.');
  }
  if (Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) throw new Error('AI email response is too large.');
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('AI email response is too large.');
  const envelope = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
  const choice = envelope.choices?.[0];
  let parsed: unknown;
  try { parsed = JSON.parse(choice?.message?.content?.trim() || ''); } catch { throw new RetryableEmailError('AI email response was cut off.'); }
  return GroqEmailSchema.parse(parsed);
}

export async function draftEmailWithGroq(context: EmailDraftContext, alternate = false, timeouts: number[] = EMAIL_ATTEMPT_TIMEOUTS_MS) {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!isGroqEmailEnabled() || !key) return null;
  const model = process.env.GROQ_EMAIL_MODEL?.trim() || 'openai/gpt-oss-120b';
  if (!/^[a-zA-Z0-9._/-]+$/.test(model)) throw new Error('The email AI model name is invalid.');
  let draft: z.infer<typeof GroqEmailSchema> | undefined;
  for (const [attempt, timeoutMs] of timeouts.entries()) {
    try { draft = await requestDraft(model, key, context, alternate, timeoutMs); break; }
    catch (error) { if (!(error instanceof RetryableEmailError) || attempt === timeouts.length - 1) throw error; }
  }
  if (!draft) throw new Error('AI email writing is unavailable.');
  const tidy = { subject: plainTypography(draft.subject), body: tidyEmailBody(plainTypography(draft.body), context.signature) };
  rejectInternalNoteLanguage(tidy.body, context);
  return tidy;
}
