import Tesseract from 'tesseract.js';
import type { CardReadOutput } from '../shared/contracts.js';

const companyEndings = /\b(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|company|co\.?|group|gmbh|plc|studio|studios|technologies|technology|systems|solutions)\b/i;
const roleWords = /\b(ceo|cto|cfo|coo|founder|president|vice president|director|manager|engineer|designer|sales|marketing|consultant|chief|officer|owner|partner|lead|specialist|executive|developer|buyer)\b/i;

export function extractCardFields(text: string): CardReadOutput {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim()).filter((line) => line.length > 1);
  const joined = lines.join('\n');
  const email = joined.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? '';
  const website = joined.replace(email, ' ').match(/(?:https?:\/\/)?(?:www\.)?[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i)?.[0]?.replace(/^https?:\/\//i, '') ?? '';
  const phone = joined.match(/(?:\+?\d[\d().\s-]{7,}\d)/)?.[0]?.replace(/\s+/g, ' ').trim() ?? '';
  const company = lines.find((line) => companyEndings.test(line) && !/@|https?:|www\./i.test(line) && line.length < 90) ??
    lines.find((line) => line === line.toLocaleUpperCase() && /^[A-Z][A-Z0-9&' -]{2,50}$/.test(line) && line.split(/\s+/).length <= 5) ?? '';
  const title = lines.find((line) => roleWords.test(line) && !companyEndings.test(line) && line.length < 90) ?? '';
  const name = lines.find((line) => {
    const words = line.split(/\s+/);
    return words.length >= 2 && words.length <= 4 && line !== line.toLocaleUpperCase() && /^[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){1,3}$/u.test(line) && !roleWords.test(line) && !companyEndings.test(line);
  }) ?? '';
  const fields = { name, title, company, email, phone, website };
  return { ...fields, products: [], topics: [], uncertain: Object.entries(fields).filter(([, value]) => Boolean(value)).map(([key]) => key) as CardReadOutput['uncertain'] };
}

export async function readCardInBrowser(image: Blob, onProgress: (progress: number, label: string) => void) {
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr',
    langPath: '/ocr',
    workerBlobURL: false,
    cachePath: 'gather-ocr-v1',
    logger: (message) => onProgress(Math.max(0, Math.min(100, Math.round(message.progress * 100))), message.status),
  });
  try {
    await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
    const { data } = await worker.recognize(image);
    return { fields: extractCardFields(data.text), confidence: data.confidence, text: data.text };
  } finally {
    await worker.terminate();
  }
}
