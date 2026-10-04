export type TemplateTone = 'Friendly' | 'Professional' | 'Short';

export type TemplateEmailInput = {
  firstName: string;
  tone: TemplateTone;
  variant: 'first' | 'alternate';
  eventName: string | null;
  /** A narrow, already-sanitised phrase about what the contact needs. Empty when unknown. */
  topic: string;
  productsOfInterest: string[];
  requestedWrittenFollowUp: boolean;
  signature: string;
};

function listOf(items: string[]) {
  const shown = items.slice(0, 3);
  if (shown.length <= 1) return shown[0] ?? '';
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

const closings: Record<TemplateTone, string> = { Friendly: 'Best,', Professional: 'Kind regards,', Short: 'Thanks,' };
const alreadyClosed = /^(?:best|best regards|regards|kind regards|warm regards|thanks|thank you|cheers|sincerely)\b/i;

/**
 * Plain-text fallback used when no AI draft is available. It only restates facts the team saved
 * (event, products of interest, a checked topic) and asks a neutral question, so it never invents
 * a price, offer, sample or agreement. Every piece is optional and simply left out when unknown.
 */
export function composeTemplateEmail(input: TemplateEmailInput): { subject: string; body: string } {
  const { tone, variant, eventName, productsOfInterest, requestedWrittenFollowUp } = input;
  const event = eventName?.trim() || '';
  const topic = input.topic.trim().replace(/[.?!]+$/, '');
  const products = listOf(productsOfInterest.map((item) => item.trim()).filter(Boolean));
  const firstProduct = productsOfInterest[0]?.trim() || '';

  const subject = requestedWrittenFollowUp ? 'Following up on your project request'
    : variant === 'alternate'
      ? event ? `Following up from ${event}` : firstProduct ? `Next steps on ${firstProduct}` : 'A quick follow-up'
      : event ? `Great to meet you at ${event}` : firstProduct ? `Following up on ${firstProduct}` : 'Following up on our conversation';

  const greeting = `${tone === 'Professional' ? 'Hello' : 'Hi'} ${input.firstName || 'there'},`;

  const opener = variant === 'alternate'
    ? { Friendly: 'Hope things are going well since we spoke.', Professional: 'I hope you are well.', Short: 'A quick follow-up from me.' }[tone]
    : event
      ? { Friendly: `It was great meeting you at ${event}.`, Professional: `Thank you for taking the time to speak with me at ${event}.`, Short: `Good meeting you at ${event}.` }[tone]
      : { Friendly: 'It was great talking with you.', Professional: 'Thank you for speaking with me.', Short: 'Good talking with you.' }[tone];

  const context = topic
    ? { Friendly: `I wanted to pick up on ${topic}.`, Professional: `I am writing regarding ${topic}.`, Short: `About ${topic}.` }[tone]
    : products
      ? { Friendly: `I noted your interest in ${products}.`, Professional: `I have noted your interest in ${products}.`, Short: `I noted your interest in ${products}.` }[tone]
      : '';

  const ask = requestedWrittenFollowUp
    ? { Friendly: 'As requested, this is my written follow-up. What scope would you like us to cover, and what questions can I answer?', Professional: 'As requested, I am following up in writing. Please let me know the scope you would like us to cover and any questions you would like addressed.', Short: 'Following up in writing as requested. What scope should we cover, and what questions can I answer?' }[tone]
    : variant === 'alternate'
      ? { Friendly: 'If it helps, tell me the main thing you would like us to cover and we can go from there.', Professional: 'Please let me know the main point you would like us to address.', Short: 'What is the main thing you need from us?' }[tone]
      : { Friendly: 'What would be most useful for me to send you next?', Professional: 'Please let me know what would be most helpful for us to provide next.', Short: 'What should I send you next?' }[tone];

  const signature = input.signature.trim();
  const closing = alreadyClosed.test(signature) ? '' : `${closings[tone]}\n`;
  const paragraph = tone === 'Short' ? [[opener, context, ask].filter(Boolean).join(' ')] : [`${opener}${context ? ` ${context}` : ''}`, ask];
  const body = [greeting, ...paragraph.filter(Boolean), `${closing}${signature}`].join('\n\n');
  return { subject, body };
}
