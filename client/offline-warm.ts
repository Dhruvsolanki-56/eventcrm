const KEY = 'gather-ocr-warm-v1';
// Smallest WebAssembly module that uses SIMD; the OCR engine picks its build the same way.
const simdProbe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

/**
 * Once the installed app has loaded on a good connection, save the card-reading files (about 15 MB) on the
 * device. Without this, offline card reading only works after the first scan has already been done online.
 */
export function warmOfflineReading() {
  try {
    if (!('serviceWorker' in navigator) || !('caches' in window) || !navigator.onLine) return;
    if (localStorage.getItem(KEY) === '1') return;
    const connection = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return;
  } catch { return; }
  const run = async () => {
    try {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) return; // the next visit will be controlled
      const simd = WebAssembly.validate(simdProbe);
      for (const path of ['/ocr/worker.min.js', simd ? '/ocr/tesseract-core-simd-lstm.wasm.js' : '/ocr/tesseract-core-lstm.wasm.js', '/ocr/eng.traineddata.gz']) {
        const response = await fetch(path);
        if (!response.ok) return;
        await response.arrayBuffer();
      }
      localStorage.setItem(KEY, '1');
    } catch { /* try again on the next visit */ }
  };
  const later = (window as unknown as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
  window.setTimeout(() => { if (later) later(() => void run(), { timeout: 15_000 }); else void run(); }, 8_000);
}
