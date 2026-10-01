import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import jsQR from 'jsqr';

const outputDirectory = fileURLToPath(new URL('../public/demo/', import.meta.url));

function multiply(a, b) {
  let result = 0;
  while (b) {
    if (b & 1) result ^= a;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
    b >>>= 1;
  }
  return result;
}

function reedSolomon(data, degree) {
  let generator = [1];
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    const next = Array(generator.length + 1).fill(0);
    generator.forEach((value, index) => {
      next[index] ^= value;
      next[index + 1] ^= multiply(value, root);
    });
    generator = next;
    root = multiply(root, 2);
  }
  const remainder = [...data, ...Array(degree).fill(0)];
  for (let i = 0; i < data.length; i += 1) {
    const factor = remainder[i];
    if (factor) generator.forEach((value, offset) => { remainder[i + offset] ^= multiply(value, factor); });
  }
  return remainder.slice(data.length);
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

export function qrCodeV1Low(text) {
  const bytes = [...new TextEncoder().encode(text)];
  if (bytes.length > 17) throw new Error('Demo QR text must be at most 17 UTF-8 bytes (version 1-L).');
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  bytes.forEach((byte) => appendBits(bits, byte, 8));
  const capacity = 19 * 8;
  for (let i = 0; i < Math.min(4, capacity - bits.length); i += 1) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  for (let pad = 0; data.length < 19; pad += 1) data.push(pad % 2 ? 0x11 : 0xec);
  const codewords = [...data, ...reedSolomon(data, 7)];
  const size = 21;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x, y, dark) => { if (x >= 0 && y >= 0 && x < size && y < size) { modules[y][x] = dark; reserved[y][x] = true; } };

  for (const [originX, originY] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dy = -1; dy <= 7; dy += 1) for (let dx = -1; dx <= 7; dx += 1) {
      const x = originX + dx; const y = originY + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const inFinder = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark = inFinder && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      set(x, y, dark);
    }
  }
  for (let i = 8; i < size - 8; i += 1) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }

  const formatData = 0b01000;
  let formatRemainder = formatData << 10;
  for (let bit = 14; bit >= 10; bit -= 1) if ((formatRemainder >>> bit) & 1) formatRemainder ^= 0x537 << (bit - 10);
  const format = ((formatData << 10) | formatRemainder) ^ 0x5412;
  for (let i = 0; i < 15; i += 1) {
    const dark = ((format >>> i) & 1) === 1;
    if (i < 6) set(8, i, dark);
    else if (i < 8) set(8, i + 1, dark);
    else if (i === 8) set(7, 8, dark);
    else set(14 - i, 8, dark);
    if (i < 8) set(size - 1 - i, 8, dark);
    else set(8, size - 15 + i, dark);
  }
  set(8, size - 8, true);

  const allBits = codewords.flatMap((byte) => Array.from({ length: 8 }, (_, index) => (byte >>> (7 - index)) & 1));
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let offset = 0; offset < size; offset += 1) {
      const y = upward ? size - 1 - offset : offset;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (reserved[y][x]) continue;
        let dark = bitIndex < allBits.length && allBits[bitIndex] === 1;
        bitIndex += 1;
        if ((x + y) % 2 === 0) dark = !dark;
        modules[y][x] = dark;
      }
    }
  }
  if (bitIndex < allBits.length) throw new Error('The sample QR did not have enough data modules.');
  return modules;
}

function qrSvg(modules, scale = 10, quiet = 4) {
  const size = modules.length + quiet * 2;
  const squares = [];
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) squares.push(`M${x + quiet} ${y + quiet}h1v1h-1z`); }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size * scale}" height="${size * scale}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${squares.join('')}" fill="#17191f"/></svg>`;
}

function validateQr(modules, expected) {
  const scale = 8; const quiet = 4; const size = modules.length + quiet * 2;
  const width = size * scale; const pixels = new Uint8ClampedArray(width * width * 4);
  for (let py = 0; py < width; py += 1) for (let px = 0; px < width; px += 1) {
    const x = Math.floor(px / scale) - quiet; const y = Math.floor(py / scale) - quiet;
    const dark = y >= 0 && x >= 0 && y < modules.length && x < modules.length && modules[y][x];
    const at = (py * width + px) * 4;
    pixels[at] = pixels[at + 1] = pixels[at + 2] = dark ? 23 : 255;
    pixels[at + 3] = 255;
  }
  const decoded = jsQR(pixels, width, width, { inversionAttempts: 'dontInvert' });
  if (decoded?.data !== expected) throw new Error(`Generated sample QR did not round-trip (read: ${decoded?.data ?? 'nothing'}).`);
}

const cardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750" viewBox="0 0 1200 750">
  <rect width="1200" height="750" fill="#edeae3"/><rect x="54" y="54" width="1092" height="642" rx="18" fill="#fff" stroke="#d7d1c7" stroke-width="3"/>
  <rect x="54" y="54" width="22" height="642" rx="11" fill="#2447d6"/>
  <text x="110" y="164" font-family="Arial,sans-serif" font-size="31" letter-spacing="5" fill="#2447d6" font-weight="700">ACME PACKAGING</text>
  <text x="110" y="300" font-family="Arial,sans-serif" font-size="68" fill="#1b1a17" font-weight="700">Demo Contact</text>
  <text x="110" y="365" font-family="Arial,sans-serif" font-size="36" fill="#6b675f">Packaging Buyer</text>
  <path d="M110 425h880" stroke="#e4dfd6" stroke-width="3"/>
  <text x="110" y="493" font-family="Arial,sans-serif" font-size="31" fill="#1b1a17">demo.contact@sample.invalid</text>
  <text x="110" y="552" font-family="Arial,sans-serif" font-size="31" fill="#1b1a17">+1 415 555 0199</text>
  <text x="110" y="620" font-family="Arial,sans-serif" font-size="27" fill="#2447d6">https://acme.co</text>
</svg>`;

async function screenshotSvg(browser, svg, path) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;width:max-content;height:max-content"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" /></body></html>`);
  await page.locator('img').evaluate((image) => (image).decode());
  await page.locator('img').screenshot({ path });
  await page.close();
}

async function generate() {
  const qrPayload = 'https://acme.co';
  const modules = qrCodeV1Low(qrPayload);
  validateQr(modules, qrPayload);
  const qr = qrSvg(modules, 12, 4).replace('<svg ', '<svg x="0" y="0" ');
  const brochureSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
    <rect width="1600" height="1000" fill="#f4f1e8"/><rect x="56" y="56" width="1488" height="888" rx="20" fill="#fff" stroke="#e4dfd6" stroke-width="3"/>
    <rect x="56" y="56" width="1488" height="20" rx="10" fill="#e8743b"/>
    <text x="120" y="190" font-family="Arial,sans-serif" font-size="35" letter-spacing="5" fill="#2447d6" font-weight="700">ACME PACKAGING</text>
    <text x="120" y="300" font-family="Arial,sans-serif" font-size="66" fill="#1b1a17" font-weight="700">Materials for a lighter shipment</text>
    <text x="120" y="385" font-family="Arial,sans-serif" font-size="36" fill="#6b675f">Product guide · event sample</text>
    <rect x="120" y="470" width="900" height="290" rx="14" fill="#f6f3ee"/>
    <circle cx="180" cy="560" r="13" fill="#1f8a5b"/><text x="220" y="572" font-family="Arial,sans-serif" font-size="35" fill="#1b1a17">Sample cartons</text>
    <text x="120" y="845" font-family="Arial,sans-serif" font-size="25" fill="#6b675f">Scan to open the sample company website</text>
    <g transform="translate(1080 455)">${qr}</g>
  </svg>`;

  await mkdir(outputDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    await screenshotSvg(browser, cardSvg, `${outputDirectory}/sample-card.png`);
    await screenshotSvg(browser, brochureSvg, `${outputDirectory}/sample-brochure-qr.png`);
    await screenshotSvg(browser, qr, `${outputDirectory}/sample-qr-code.png`);
  } finally { await browser.close(); }
  await writeFile(`${outputDirectory}/sample-card.txt`, 'AI_MODE=demo sample card\nFixed test result: Demo Contact · Packaging Buyer · Acme Packaging · demo.contact@sample.invalid · +1 415 555 0199 · https://acme.co\n');
  await writeFile(`${outputDirectory}/sample-brochure-qr.txt`, 'AI_MODE=demo sample brochure\nVisible items: Sample cartons; Recyclable mailers\nQR payload: https://acme.co\n');
  console.info('Generated three PNG fixtures; the embedded QR was decoded locally by jsQR before export.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await generate();
