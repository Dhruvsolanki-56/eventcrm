import Tesseract from 'tesseract.js';
import type { CardReadOutput } from '../shared/contracts.js';

const companyEndings = /\b(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|company|co\.?|group|gmbh|plc|studio|studios|technologies|technology|systems|solutions|labs?|partners|industries|holdings|associates)\b/i;
const roleWords = /\b(ceo|cto|cfo|coo|chief|officer|founder|president|vice president|vp|head of|director|manager|engineer|designer|sales|marketing|consultant|owner|partner|lead|specialist|executive|developer|buyer|architect|analyst|coordinator|representative|account executive|business development|product manager|project manager|customer success|human resources|operations)\b/i;
const companyLabel = /^(?:company|organization|organisation|employer)\s*[:—-]\s*(.+)$/i;
const nameLabel = /^(?:name|contact|person)\s*[:—-]\s*(.+)$/i;
const titleLabel = /^(?:job title|title|position|role)\s*[:—-]\s*(.+)$/i;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const emailLikePattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]*/gi;
const websitePattern = /(?:https?:\/\/)?(?:www\.)?[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}(?:\/[A-Z0-9._~:/?#[\]@!$&'()*+,;=-]*)?/gi;
const phonePattern = /(?:\+?\d[\d().\s-]{7,}\d)/g;
const nameShape = /^[\p{Lu}][\p{L}'’.\-]+(?:\s+[\p{Lu}][\p{L}'’.\-]+){1,3}$/u;

function labeledValue(line: string, label: RegExp) {
  return line.match(label)?.[1]?.trim() ?? '';
}

function normalized(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isAllCaps(line: string) {
  return line === line.toLocaleUpperCase() && /[A-Z]/.test(line);
}

// Text reading often puts a space around "@" or after "www." and mixes up the ends of company names (llc, ltd, inc).
function repairContactText(text: string) {
  return text
    .replace(/([A-Za-z0-9._%+-])[ \t]+@[ \t]*(?=[A-Za-z0-9])/g, '$1@')
    .replace(/@[ \t]+(?=[A-Za-z0-9-]+\.)/g, '@')
    .replace(/\bwww\.[ \t]+(?=[a-z0-9])/gi, 'www.');
}

function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

// A card usually names the company inside its web address. When the address is a letter or two away from that
// name, the reading is almost certainly the one that slipped (for example "llc" read as "lic").
function snapToCompany(host: string, companyKey: string) {
  const parts = host.split('.');
  const label = parts[0] ?? '';
  if (!companyKey || label === companyKey || label.length < 8 || companyKey.length < 8 || Math.abs(label.length - companyKey.length) > 2) return host;
  // A name that merely continues or stops short of the other is a different address or a cut-off, not a misread.
  if (companyKey.startsWith(label) || label.startsWith(companyKey)) return host;
  return editDistance(label, companyKey) <= 2 ? [companyKey, ...parts.slice(1)].join('.') : host;
}

export function extractCardFields(rawText: string): CardReadOutput {
  const text = repairContactText(rawText);
  const sourceLines = text.split(/\r?\n/).flatMap((line) => line.split(/\s+\|\s+/));
  const sourceText = sourceLines.join('\n');
  const email = sourceText.match(emailPattern)?.[0] ?? '';
  const emailLikeLocal = sourceText.match(emailLikePattern)?.[0]?.split('@')[0] ?? '';
  const website = sourceText.replace(emailLikePattern, ' ').match(websitePattern)?.[0]?.replace(/^https?:\/\//i, '') ?? '';
  const phone = sourceText.match(phonePattern)?.[0]?.replace(/\s+/g, ' ').trim() ?? '';
  const lines = sourceLines
    .map((line) => line.replace(emailLikePattern, ' ').replace(websitePattern, ' ').replace(phonePattern, ' ')
      .replace(/^\s*(?:\([A-Z0-9]\s*(?:\]|\|)|\[[A-Z0-9]\]|[A-Z0-9]\])\s*/i, '')
      .replace(/^[\s([{,;:!?.~`'’»«|]+|[|¦]+\s*$/gu, '')
      .replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 1);
  const emailLocal = (email || emailLikeLocal).split('@')[0]?.toLowerCase().split(/[._+-]+/).filter(Boolean) ?? [];
  const contactDomain = [email.split('@')[1]?.split('.')[0], website.match(/(?:https?:\/\/)?(?:www\.)?([^./?#]+)/i)?.[1]]
    .filter((part): part is string => Boolean(part))
    .map(normalized)
    .filter((part) => part.length >= 4 && !['gmail', 'outlook', 'hotmail', 'yahoo', 'icloud', 'protonmail'].includes(part));

  const candidates = lines.map((raw, index) => ({
    raw,
    index,
    explicitName: labeledValue(raw, nameLabel),
    explicitCompany: labeledValue(raw, companyLabel),
    explicitTitle: labeledValue(raw, titleLabel),
    value: labeledValue(raw, nameLabel) || labeledValue(raw, companyLabel) || labeledValue(raw, titleLabel) || raw,
  }));
  const contactLine = (line: string) => /@|https?:|www\./i.test(line) || (line.match(/\d/g)?.length ?? 0) >= 7;
  const titleLine = candidates.find((line) => (line.explicitTitle || roleWords.test(line.value)) && !companyEndings.test(line.value));
  const title = titleLine?.explicitTitle || titleLine?.value || '';
  const domainMatch = (value: string) => {
    const key = normalized(value);
    const words = value.match(/[\p{L}\p{N}]+/gu) ?? [];
    return contactDomain.some((domain) => key.length >= 4 && (domain.includes(key) || words.some((word) => normalized(word).length >= 4 && domain.includes(normalized(word)))));
  };
  const hasIndependentCompanyEvidence = (candidateIndex: number) => candidates.some((line) => line.index !== candidateIndex &&
    (line.explicitCompany || companyEndings.test(line.value) || domainMatch(line.value) ||
      (isAllCaps(line.value) && (!titleLine || Math.abs(line.index - titleLine.index) > 1 || line.index > titleLine.index))));

  const nameCandidates = candidates.map((line) => {
    const value = line.explicitName || line.value;
    const tokens = value.match(/[\p{L}]+/gu) ?? [];
    const shaped = tokens.length >= 2 && tokens.length <= 4 && nameShape.test(value);
    const matchingEmailTokens = tokens.filter((token) => emailLocal.some((part) => part.length >= 3 && normalized(token) === normalized(part))).length;
    const emailMatchesFullName = Boolean(email && emailLocal.join('') === normalized(tokens.join('')));
    const localPartMatches = emailMatchesFullName || matchingEmailTokens >= 2 ||
      (matchingEmailTokens === 1 && (line.explicitName || !titleLine || line.index < titleLine.index));
    const nearTitle = Boolean(titleLine && Math.abs(line.index - titleLine.index) === 1);
    const hasCompanyIdentity = Boolean(line.explicitCompany || companyEndings.test(value) || (domainMatch(value) && !localPartMatches) ||
      (isAllCaps(value) && !line.explicitName && !localPartMatches && !hasIndependentCompanyEvidence(line.index)));
    const supported = Boolean(line.explicitName || localPartMatches || (nearTitle && hasIndependentCompanyEvidence(line.index)));
    const allowed = shaped && supported && !hasCompanyIdentity && !contactLine(line.raw) && !roleWords.test(value);
    const score = !allowed ? 0 : line.explicitName ? 100 : (localPartMatches ? 70 : 0) + (nearTitle ? 60 : 0);
    return { ...line, value, score };
  }).filter((line) => line.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const name = nameCandidates[0]?.value ?? '';
  const nameLineIndex = nameCandidates[0]?.index;

  const companyCandidates = candidates.map((line) => {
    const value = line.explicitCompany || line.value;
    const domainMatchesCompany = domainMatch(value);
    const ambiguousAllCapsName = isAllCaps(value) && titleLine && line.index < titleLine.index && Math.abs(line.index - titleLine.index) === 1;
    const looksLikeCompany = companyEndings.test(value) || isAllCaps(value) || domainMatchesCompany;
    const excludedPerson = line.index === nameLineIndex;
    const score = excludedPerson || contactLine(line.raw) || roleWords.test(value) ? 0
      : line.explicitCompany ? 100
        : companyEndings.test(value) ? 80
          : domainMatchesCompany ? 70
            : isAllCaps(value) && looksLikeCompany && !ambiguousAllCapsName ? 60 : 0;
    return { ...line, value, score };
  }).filter((line) => line.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const company = companyCandidates[0]?.value ?? '';
  const companyKey = normalized(company);
  let fixedEmail = email;
  let fixedWebsite = website;
  const websiteHost = website.replace(/^www\./i, '').split('/')[0].toLowerCase();
  const websitePrefix = /^www\./i.test(website) ? website.slice(0, 4) : '';
  if (website && companyKey) fixedWebsite = `${websitePrefix}${snapToCompany(websiteHost, companyKey)}${website.slice(websitePrefix.length + websiteHost.length)}`;
  if (email && companyKey) {
    const [local, domain = ''] = email.split('@');
    fixedEmail = `${local}@${snapToCompany(domain.toLowerCase(), companyKey)}`;
  }
  // Sample cards and templates print stand-in details such as "yourname@email.com" or "+123-456-7890". They are not real.
  const placeholderEmail = (value: string) => /^(?:your[._-]?(?:name|email|mail)|name|email|username|firstname[._-]?lastname|first[._-]?last|john[._-]?doe|someone|info)@(?:email|example|domain|yourdomain|yourcompany|company|website|mail)\.(?:com|net|org)$/i.test(value);
  const placeholderPhone = (value: string) => ['1234567890', '123456789', '12345678', '0000000000', '1111111111', '5555555555'].includes(value.replace(/\D/g, '').replace(/^(\d{10,})$/, (all) => all.slice(-10))) || /^(\d)\1{6,}$/.test(value.replace(/\D/g, ''));
  const placeholderSite = (value: string) => /^(?:www\.)?(?:your(?:website|company|domain|name)|website|example|domain|company)\.(?:com|net|org)\b/i.test(value);
  const fields = {
    name, title, company,
    email: placeholderEmail(fixedEmail) ? '' : fixedEmail,
    phone: placeholderPhone(phone) ? '' : phone,
    website: placeholderSite(fixedWebsite) ? '' : fixedWebsite,
  };
  return { ...fields, products: [], topics: [], uncertain: Object.entries(fields).filter(([, value]) => Boolean(value)).map(([key]) => key) as CardReadOutput['uncertain'] };
}

// OCR suggestions always need a human check. That alone is not a reason to
// delay review with a second, remote read.
export function needsCardAiFallback(fields: Pick<CardReadOutput, 'name' | 'email' | 'phone'> | null) {
  return !fields || !fields.name.trim() || (!fields.email.trim() && !fields.phone.trim());
}

async function cropCardFooter(image: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    return null;
  }
  try {
    const aspect = bitmap.width / bitmap.height;
    if (aspect < 1.2 || aspect > 2.4) return null;
    const top = Math.round(bitmap.height * 0.65);
    const height = Math.round(bitmap.height * 0.23);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, top, bitmap.width, height, 0, 0, bitmap.width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    bitmap.close();
  }
}

let ocrWorker: Promise<Awaited<ReturnType<typeof Tesseract.createWorker>>> | null = null;
let progressListener: ((progress: number, label: string) => void) | null = null;
let ocrQueue: Promise<unknown> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export function warmCardReader() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!ocrWorker) ocrWorker = Tesseract.createWorker('eng', 1, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr',
    langPath: '/ocr',
    workerBlobURL: false,
    cachePath: 'gather-ocr-v1',
    logger: (message) => progressListener?.(Math.max(0, Math.min(100, Math.round(message.progress * 100))), message.status),
  }).catch((error) => { ocrWorker = null; throw error; });
  if (!progressListener) idleTimer = setTimeout(() => { const old = ocrWorker; ocrWorker = null; if (old) void old.then((ready) => ready.terminate()).catch(() => undefined); }, 90_000);
  return ocrWorker;
}

export async function readCardInBrowser(image: Blob, onProgress: (progress: number, label: string) => void) {
  const run = async () => {
    progressListener = onProgress;
    const worker = await warmCardReader();
    try {
    await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300', tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
    const { data } = await worker.recognize(image);
    let fields = extractCardFields(data.text);
    let text = data.text;
    if (!fields.name) {
      onProgress(0, 'Checking another card layout…');
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
      const alternate = await worker.recognize(image);
      const alternateFields = extractCardFields(alternate.data.text);
      if (alternateFields.name) {
        fields = {
          ...fields,
          name: alternateFields.name,
          uncertain: fields.uncertain.includes('name') ? fields.uncertain : [...fields.uncertain, 'name'],
        };
      }
      text = `${text}\n${alternate.data.text}`;
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
    }
    if (!fields.company) {
      onProgress(0, 'Checking the card footer…');
      const footer = await cropCardFooter(image);
      if (footer) {
        const footerRead = await worker.recognize(footer);
        const footerFields = extractCardFields(footerRead.data.text);
        if (footerFields.company) {
          fields = {
            ...fields,
            company: footerFields.company,
            uncertain: fields.uncertain.includes('company') ? fields.uncertain : [...fields.uncertain, 'company'],
          };
          text = `${text}\n${footerRead.data.text}`;
        }
      }
    }
    return { fields, confidence: data.confidence, text };
    } catch (error) {
      const broken = ocrWorker;
      ocrWorker = null;
      if (broken) void broken.then((ready) => ready.terminate()).catch(() => undefined);
      throw error;
    } finally {
      progressListener = null;
      if (idleTimer) clearTimeout(idleTimer);
      if (ocrWorker) idleTimer = setTimeout(() => { const old = ocrWorker; ocrWorker = null; if (old) void old.then((ready) => ready.terminate()).catch(() => undefined); }, 90_000);
    }
  };
  const result = ocrQueue.then(run, run);
  ocrQueue = result.catch(() => undefined);
  return result;
}
