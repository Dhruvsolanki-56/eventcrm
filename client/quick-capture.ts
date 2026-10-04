/** Helpers for tap-to-capture: turning a tapped chip into a plain sentence in a note, and back. */

export type NoteChip = { label: string; sentence: string };

// "Asked for …" and "Asked about …" are the phrases the draft writer already understands as what the person needs.
export const outcomeChips: NoteChip[] = [
  { label: 'Wants samples', sentence: 'Asked for samples.' },
  { label: 'Wants a quote', sentence: 'Asked for a quote.' },
  { label: 'Wants more info', sentence: 'Asked for more information.' },
  { label: 'Call me back', sentence: 'Asked us to call back.' },
  { label: 'Wants to meet again', sentence: 'Wants to meet again.' },
  { label: 'Met again', sentence: 'Met again.' },
  { label: 'Not a fit now', sentence: 'Not a fit right now.' },
];

export function productChips(names: string[]): NoteChip[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].slice(0, 6)
    .map((name) => ({ label: name, sentence: `Asked about ${name}.` }));
}

export function hasSentence(value: string, sentence: string) {
  return value.includes(sentence);
}

/** Adds the sentence if it is missing, removes it if it is already there. Free text around it is kept. */
export function toggleSentence(value: string, sentence: string, maxLength = 4000) {
  if (hasSentence(value, sentence)) {
    return value.replace(sentence, '').replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  const base = value.trimEnd();
  const next = base ? `${base}${/[.!?]$/.test(base) ? ' ' : '. '}${sentence}` : sentence;
  return next.length > maxLength ? value : next;
}

/** Adds spoken text after what is already written. */
export function appendText(value: string, text: string, maxLength = 4000) {
  const clean = text.trim();
  if (!clean) return value;
  const base = value.trimEnd();
  const next = base ? `${base}\n${clean}` : clean;
  return next.slice(0, maxLength);
}

export const followUpChips = [
  { label: 'Tomorrow', days: 1 },
  { label: 'In 3 days', days: 3 },
  { label: 'Next week', days: 7 },
  { label: 'In 2 weeks', days: 14 },
] as const;

export const followUpIdeas = ['Check in', 'Share samples', 'Send a quote', 'Book a call'];
export const meetingIdeas = ['Intro call', 'Product demo', 'Review samples'];

/** Sets a short note from a tapped idea, or adds to what the person already typed. */
export function applyIdea(current: string, idea: string, ideas: string[]) {
  const trimmed = current.trim();
  if (!trimmed || ideas.includes(trimmed)) return idea;
  if (trimmed.toLowerCase().includes(idea.toLowerCase())) return current;
  return `${trimmed}; ${idea}`;
}

/** Lists the review fields that need a look: the reader flagged them or found nothing. */
export function fieldsNeedingLook<K extends string>(keys: readonly K[], values: Record<K, string>, uncertain: readonly string[]): K[] {
  return keys.filter((key) => uncertain.includes(key) || !values[key]?.trim());
}

/** Phrases people commonly use for "our role" and "never promise" in the business profile. */
export const roleIdeas = ['We are their supplier', 'We are their service partner', 'We are a distributor', 'We make custom products'];
export const neverPromiseIdeas = ['Prices', 'Delivery dates', 'Discounts', 'Exclusivity', 'Samples'];

/** Adds a word to a comma-separated list without repeating it. */
export function addListPhrase(current: string, phrase: string, maxLength = 500) {
  const items = current.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
  if (items.some((item) => item.toLowerCase() === phrase.toLowerCase())) return current;
  const next = [...items, phrase].join(', ');
  return next.length > maxLength ? current : next;
}

/** Reads a small remembered choice from this device. Returns the fallback when storage is unavailable. */
export function rememberedNumber(key: string, allowed: readonly number[], fallback: number) {
  try { const value = Number(window.localStorage.getItem(key)); return allowed.includes(value) ? value : fallback; } catch { return fallback; }
}
export function remember(key: string, value: string | number) {
  try { window.localStorage.setItem(key, String(value)); } catch { /* A remembered choice is only a convenience. */ }
}
