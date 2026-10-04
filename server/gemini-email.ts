import { z } from 'zod';
import { isGeminiCardEnabled } from './gemini-card.js';
import { emailWritingInstruction, rejectInternalNoteLanguage, tidyEmailBody, type EmailDraftContext } from './email-writing.js';

const GeminiEmailSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
}).strict();

const MAX_RESPONSE_BYTES = 32 * 1024;
// The hosted site waits about 26 seconds for the server, so two tries must fit inside that.
const EMAIL_ATTEMPT_TIMEOUTS_MS = [14_000, 9_000];

class RetryableEmailError extends Error {}

// Drafts need no deep reasoning; thinking makes the small models slow and unreliable.
const thinkingFor = (model: string) => /^gemini-3/.test(model) ? { thinkingLevel: 'minimal' } : /^gemini-2\.5-flash/.test(model) ? { thinkingBudget: 0 } : undefined;

export const isGeminiEmailEnabled = () => isGeminiCardEnabled();

async function requestDraft(model: string, key: string, context: EmailDraftContext, alternate: boolean, timeoutMs: number) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(context) }] }],
      systemInstruction: { parts: [{ text: emailWritingInstruction(alternate) }] },
      generationConfig: { temperature: alternate ? 0.4 : 0.15, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { subject: { type: 'STRING' }, body: { type: 'STRING' } }, required: ['subject', 'body'] }, maxOutputTokens: 2048, thinkingConfig: thinkingFor(model) },
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
  const envelope = JSON.parse(raw) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const content = envelope.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim() || '';
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new RetryableEmailError('AI email response was cut off.'); }
  return GeminiEmailSchema.parse(parsed);
}

export async function draftEmailWithGemini(context: EmailDraftContext, alternate = false) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!isGeminiEmailEnabled() || !key) return null;
  const model = process.env.GEMINI_EMAIL_MODEL?.trim() || 'gemini-3.1-flash-lite';
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('The email AI model name is invalid.');
  let draft: z.infer<typeof GeminiEmailSchema> | undefined;
  for (const [attempt, timeoutMs] of EMAIL_ATTEMPT_TIMEOUTS_MS.entries()) {
    try { draft = await requestDraft(model, key, context, alternate, timeoutMs); break; }
    catch (error) { if (!(error instanceof RetryableEmailError) || attempt === EMAIL_ATTEMPT_TIMEOUTS_MS.length - 1) throw error; }
  }
  if (!draft) throw new Error('AI email writing is unavailable.');
  const tidy = { ...draft, body: tidyEmailBody(draft.body, context.signature) };
  rejectInternalNoteLanguage(tidy.body, context);
  return tidy;
}
