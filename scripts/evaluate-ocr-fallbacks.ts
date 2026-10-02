import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CardReadOutput } from '../shared/contracts.js';
import { extractCardFields } from '../client/card-ocr.js';

type Result = {
  id: string;
  layout: string;
  split: string;
  truth: Record<'name' | 'title' | 'company' | 'email' | 'phone' | 'website', string>;
  ocrText: string;
};
type Field = keyof Result['truth'];
const fields: Field[] = ['name', 'title', 'company', 'email', 'phone', 'website'];
const [primaryDirectory, alternateDirectory, cropDirectory] = process.argv.slice(2);
if (!primaryDirectory || !alternateDirectory || !cropDirectory) {
  throw new Error('Usage: tsx scripts/evaluate-ocr-fallbacks.ts <single-block-results> <sparse-text-results> <lower-crop-results>');
}
const normal = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const matches = (a: string, b: string) => Boolean(a && b && normal(a) === normal(b));

async function readResults(directory: string, mode: 'single-block' | 'sparse-text') {
  const files = (await readdir(resolve(directory))).filter((name) => name.startsWith(`${mode}.part-`) && name.endsWith('.jsonl'));
  const rows = new Map<string, Result>();
  for (const file of files) {
    const contents = await readFile(resolve(directory, file), 'utf8');
    for (const line of contents.split(/\r?\n/).filter(Boolean)) {
      const result = JSON.parse(line) as Result;
      rows.set(result.id, result);
    }
  }
  return rows;
}

const [primary, alternate, crops] = await Promise.all([
  readResults(primaryDirectory, 'single-block'), readResults(alternateDirectory, 'sparse-text'), readResults(cropDirectory, 'single-block'),
]);
const layouts = new Map<string, { seen: number; baseline: Record<Field, number>; combined: Record<Field, number> }>();
const totals = {
  seen: 0,
  baseline: Object.fromEntries(fields.map((field) => [field, 0])) as Record<Field, number>,
  alternate: Object.fromEntries(fields.map((field) => [field, 0])) as Record<Field, number>,
  combined: Object.fromEntries(fields.map((field) => [field, 0])) as Record<Field, number>,
  sparseNamesRecovered: 0,
  footerCompaniesRecovered: 0,
  footerCropCompanySamples: 0,
  footerCropCompanyCorrect: 0,
  companyAsPersonFalsePositives: 0,
};

for (const baseResult of primary.values()) {
  const baseFields: CardReadOutput = extractCardFields(baseResult.ocrText);
  const merged: CardReadOutput = { ...baseFields, uncertain: [...baseFields.uncertain] };
  const sparseResult = alternate.get(baseResult.id);
  const cropResult = crops.get(baseResult.id);
  const sparseFields = sparseResult ? extractCardFields(sparseResult.ocrText) : null;
  const cropFields = cropResult ? extractCardFields(cropResult.ocrText) : null;
  if (baseResult.layout === 'company-footer' && cropFields) {
    totals.footerCropCompanySamples += 1;
    if (matches(cropFields.company, baseResult.truth.company)) totals.footerCropCompanyCorrect += 1;
  }
  if (!merged.name && sparseResult) {
    const alternateName = sparseFields?.name ?? '';
    if (alternateName) {
      merged.name = alternateName;
      totals.sparseNamesRecovered += 1;
    }
  }
  if (!merged.company && cropResult) {
    const footerCompany = cropFields?.company ?? '';
    if (footerCompany) {
      merged.company = footerCompany;
      totals.footerCompaniesRecovered += 1;
    }
  }
  const layout = layouts.get(baseResult.layout) ?? {
    seen: 0,
    baseline: Object.fromEntries(fields.map((field) => [field, 0])) as Record<Field, number>,
    combined: Object.fromEntries(fields.map((field) => [field, 0])) as Record<Field, number>,
  };
  layout.seen += 1;
  totals.seen += 1;
  for (const field of fields) {
    if (matches(baseFields[field], baseResult.truth[field])) {
      totals.baseline[field] += 1;
      layout.baseline[field] += 1;
    }
    if (sparseFields && matches(sparseFields[field], baseResult.truth[field])) totals.alternate[field] += 1;
    if (matches(merged[field], baseResult.truth[field])) {
      totals.combined[field] += 1;
      layout.combined[field] += 1;
    }
  }
  const normalizedName = normal(merged.name);
  const normalizedCompany = normal(baseResult.truth.company);
  if (normalizedName.length >= 6 && normalizedCompany.includes(normalizedName)) totals.companyAsPersonFalsePositives += 1;
  layouts.set(baseResult.layout, layout);
}

const percent = (value: number, seen: number) => seen ? Math.round((value / seen) * 1000) / 10 : 0;
console.log(JSON.stringify({
  samples: totals.seen,
  baselineAccuracy: Object.fromEntries(fields.map((field) => [field, percent(totals.baseline[field], totals.seen)])),
  sparseTextAccuracy: Object.fromEntries(fields.map((field) => [field, percent(totals.alternate[field], totals.seen)])),
  combinedAccuracy: Object.fromEntries(fields.map((field) => [field, percent(totals.combined[field], totals.seen)])),
  sparseNamesRecovered: totals.sparseNamesRecovered,
  footerCompaniesRecovered: totals.footerCompaniesRecovered,
  footerCropCompanyAccuracy: percent(totals.footerCropCompanyCorrect, totals.footerCropCompanySamples),
  footerCropCompanySamples: totals.footerCropCompanySamples,
  companyAsPersonFalsePositives: totals.companyAsPersonFalsePositives,
  layoutAccuracy: Object.fromEntries([...layouts].map(([layout, count]) => [layout, {
    samples: count.seen,
    baselineName: percent(count.baseline.name, count.seen),
    combinedName: percent(count.combined.name, count.seen),
    baselineCompany: percent(count.baseline.company, count.seen),
    combinedCompany: percent(count.combined.company, count.seen),
  }])),
}, null, 2));
