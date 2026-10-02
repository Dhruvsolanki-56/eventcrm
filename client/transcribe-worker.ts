import { pipeline } from '@huggingface/transformers';

type TranscribeRequest = { id: number; samples: Float32Array; language: 'english' | 'hindi' | 'gujarati' };
type SpeechResult = { text?: string } | Array<{ text?: string }>;
type SpeechRecognizer = (samples: Float32Array, options: { chunk_length_s: number; stride_length_s: number; language: string }) => Promise<SpeechResult>;

let recognizer: Promise<SpeechRecognizer> | null = null;
let queue: Promise<void> = Promise.resolve();

async function transcribe({ id, samples, language }: TranscribeRequest) {
  try {
    if (!recognizer) {
      self.postMessage({ id, status: 'loading' });
      const load = pipeline as unknown as (task: string, model: string, options: { device: string; dtype: string }) => Promise<SpeechRecognizer>;
      recognizer = load('automatic-speech-recognition', 'Xenova/whisper-tiny', { device: 'wasm', dtype: 'q8' });
    }
    const model = await recognizer;
    self.postMessage({ id, status: 'transcribing' });
    const result = await model(samples, { chunk_length_s: 30, stride_length_s: 5, language });
    const text = (Array.isArray(result) ? result.map((item) => item.text || '').join(' ') : result.text || '').trim();
    self.postMessage({ id, status: 'done', text });
  } catch {
    recognizer = null;
    self.postMessage({ id, status: 'error', message: 'Local transcription did not work on this device. Listen and type the note instead.' });
  }
}

self.onmessage = (event: MessageEvent<TranscribeRequest>) => {
  queue = queue.then(() => transcribe(event.data));
};
