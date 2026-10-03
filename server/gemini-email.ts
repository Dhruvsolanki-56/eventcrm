import { z } from 'zod';
import { isGeminiCardEnabled } from './gemini-card.js';
import { emailWritingInstruction, rejectInternalNoteLanguage, type EmailDraftContext } from './email-writing.js';

const GeminiEmailSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
}).strict();

const MAX_RESPONSE_BYTES = 32 * 1024;
const EMAIL_TIMEOUT_MS = 15_000;

export const isGeminiEmailEnabled = () => isGeminiCardEnabled();

export async function draftEmailWithGemini(context: EmailDraftContext, alternate = false) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!isGeminiEmailEnabled() || !key) return null;
  const model = process.env.GEMINI_EMAIL_MODEL?.trim() || 'gemini-3.1-flash-lite';
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('The email AI model name is invalid.');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(context) }] }],
      systemInstruction: { parts: [{ text: emailWritingInstruction(alternate) }] },
      generationConfig: { temperature: alternate ? 0.4 : 0.15, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { subject: { type: 'STRING' }, body: { type: 'STRING' } }, required: ['subject', 'body'] }, maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('AI email writing is unavailable.');
  if (Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) throw new Error('AI email response is too large.');
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('AI email response is too large.');
  const envelope = JSON.parse(raw) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const content = envelope.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim() || '';
  const draft = GeminiEmailSchema.parse(JSON.parse(content));
  rejectInternalNoteLanguage(draft.body);
  return draft;
}
