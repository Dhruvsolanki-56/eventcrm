import { mkdir, open, readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import Tesseract from 'tesseract.js';
import { extractCardFields } from '../client/card-ocr.js';

type Fixture = {
  id: string;
  split: 'train' | 'test';
  layout: string;
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  website: string;
};
type Field = 'name' | 'title' | 'company' | 'email' | 'phone' | 'website';
const fields: Field[] = ['name', 'title', 'company', 'email', 'phone', 'website'];

const directoryArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const inputDirectory = resolve(directoryArg ?? 'data/ocr-benchmark');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : Number.POSITIVE_INFINITY;
const splitArg = process.argv.find((arg) => arg.startsWith('--split='));
const split = splitArg?.slice('--split='.length);
const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
const selectedMode = modeArg?.slice('--mode='.length);
const runArg = process.argv.find((arg) => arg.startsWith('--run='));
const runId = runArg?.slice('--run='.length) ?? new Date().toISOString().replace(/[:.]/g, '-');
const workersArg = process.argv.find((arg) => arg.startsWith('--workers='));
const workerCount = Math.max(1, Math.min(8, Number(workersArg?.slice('--workers='.length) ?? Math.min(4, cpus().length)) || 1));
const resultsDirectory = resolve(inputDirectory, 'results', runId);
const normal = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const same = (a: string, b: string) => Boolean(a && b && normal(a) === normal(b));

const manifest = (await readFile(resolve(inputDirectory, 'manifest.jsonl'), 'utf8'))
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Fixture)
  .filter((item) => !split || item.split === split).slice(0, limit);
if (!manifest.length) throw new Error(`No card records were found in ${inputDirectory}.`);
await mkdir(resultsDirectory, { recursive: true });

const workerPath = resolve('node_modules/tesseract.js/src/worker-script/node/index.js');
const corePath = resolve('public/ocr');
const langPath = resolve('public/ocr');
const modes = [
  { name: 'single-block', psm: Tesseract.PSM.SINGLE_BLOCK },
  { name: 'sparse-text', psm: Tesseract.PSM.SPARSE_TEXT },
].filter((mode) => !selectedMode || mode.name === selectedMode);
if (!modes.length) throw new Error(`Unknown mode ${selectedMode}; choose single-block or sparse-text.`);

for (const mode of modes) {
  const counts = new Map<string, { seen: number; name: number; title: number; company: number; email: number; phone: number; website: number; swap: number }>();
  const layoutCounts = new Map<string, { seen: number; name: number; company: number; swap: number }>();
  const totals = { seen: 0, name: 0, title: 0, company: 0, email: 0, phone: 0, website: 0, swap: 0, confidence: 0 };
  const misses: Array<{ id: string; layout: string; name: string; gotName: string; company: string; gotCompany: string; ocrText: string }> = [];
  const startedAt = performance.now();
  let processed = 0;
  const resultFiles = Array.from({ length: Math.min(workerCount, manifest.length) }, (_, workerIndex) =>
    resolve(resultsDirectory, `${mode.name}.part-${workerIndex}.jsonl`));
  await Promise.all(resultFiles.map(async (resultPath, workerIndex) => {
    const resultFile = await open(resultPath, 'wx');
    const worker = await Tesseract.createWorker('eng', 1, { workerPath, corePath, langPath, gzip: true });
    try {
      await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300', tessedit_pageseg_mode: mode.psm });
      for (let index = workerIndex; index < manifest.length; index += resultFiles.length) {
        const item = manifest[index]!;
        const { data } = await worker.recognize(await readFile(resolve(inputDirectory, `${item.id}.png`)));
        const prediction = extractCardFields(data.text);
        const metrics = counts.get(item.split) ?? { seen: 0, name: 0, title: 0, company: 0, email: 0, phone: 0, website: 0, swap: 0 };
        const layoutMetrics = layoutCounts.get(item.layout) ?? { seen: 0, name: 0, company: 0, swap: 0 };
        const results = {
          name: same(prediction.name, item.name), title: same(prediction.title, item.title), company: same(prediction.company, item.company),
          email: same(prediction.email, item.email), phone: same(prediction.phone, item.phone), website: same(prediction.website, item.website),
        };
        metrics.seen += 1;
        layoutMetrics.seen += 1;
        totals.seen += 1;
        for (const [field, correct] of Object.entries(results)) {
          if (correct) { metrics[field as keyof typeof metrics] += 1; totals[field as keyof typeof totals] += 1; }
        }
        const normalizedName = normal(prediction.name);
        const normalizedCompany = normal(item.company);
        const companyAsPerson = Boolean(normalizedName && normalizedCompany && normalizedCompany.includes(normalizedName) && normalizedName.length >= 6);
        if (results.name) layoutMetrics.name += 1;
        if (results.company) layoutMetrics.company += 1;
        if (companyAsPerson) { metrics.swap += 1; layoutMetrics.swap += 1; totals.swap += 1; }
        totals.confidence += data.confidence;
        counts.set(item.split, metrics);
        layoutCounts.set(item.layout, layoutMetrics);
        await resultFile.write(`${JSON.stringify({ id: item.id, split: item.split, layout: item.layout, truth: { name: item.name, title: item.title, company: item.company, email: item.email, phone: item.phone, website: item.website }, prediction, ocrText: data.text, confidence: data.confidence })}\n`);
        if (misses.length < 18 && (!results.name || !results.company || companyAsPerson)) {
          misses.push({ id: item.id, layout: item.layout, name: item.name, gotName: prediction.name, company: item.company, gotCompany: prediction.company, ocrText: data.text });
        }
        processed += 1;
        if (processed % 100 === 0) process.stderr.write(`${mode.name}: ${processed}/${manifest.length}\n`);
      }
    } finally {
      await worker.terminate();
      await resultFile.close();
    }
  }));
  const percentage = (value: number, base: number) => base ? Math.round((value / base) * 1000) / 10 : 0;
  const elapsedMs = Math.round(performance.now() - startedAt);
  const report = {
    mode: mode.name,
    samples: totals.seen,
    heldOut: counts.get('test')?.seen ?? 0,
    heldOutAccuracy: Object.fromEntries(fields.map((field) => [field, percentage(counts.get('test')?.[field] ?? 0, counts.get('test')?.seen ?? 0)])),
    overallAccuracy: Object.fromEntries(fields.map((field) => [field, percentage(totals[field], totals.seen)])),
    companyAsPersonFalsePositives: totals.swap,
    averageOcrConfidence: Math.round(totals.confidence / Math.max(1, totals.seen) * 10) / 10,
    elapsedMs,
    averageMsPerCard: Math.round(elapsedMs / Math.max(1, totals.seen) * 10) / 10,
    layoutAccuracy: Object.fromEntries([...layoutCounts].map(([layout, metrics]) => [layout, {
      samples: metrics.seen,
      name: percentage(metrics.name, metrics.seen),
      company: percentage(metrics.company, metrics.seen),
      companyAsPersonFalsePositives: metrics.swap,
    }])),
    resultsFiles: resultFiles,
    examples: misses,
  };
  console.log(JSON.stringify(report, null, 2));
}
