type Progress = (message: string) => void;
export type VoiceLanguage = 'english' | 'hindi' | 'gujarati';
type WorkerReply = { id: number; status: 'loading' | 'transcribing' | 'done' | 'error'; text?: string; message?: string };

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void; progress: Progress }>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./transcribe-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    const task = pending.get(reply.id);
    if (!task) return;
    if (reply.status === 'loading') task.progress('Downloading the speech model. The recording stays on this device.');
    if (reply.status === 'transcribing') task.progress('Transcribing on this device…');
    if (reply.status === 'done') { pending.delete(reply.id); task.resolve(reply.text || ''); }
    if (reply.status === 'error') { pending.delete(reply.id); task.reject(new Error(reply.message || 'Local transcription failed.')); }
  };
  worker.onerror = () => {
    for (const task of pending.values()) task.reject(new Error('Local transcription could not start on this device.'));
    pending.clear(); worker?.terminate(); worker = null;
  };
  return worker;
}

export async function transcribeLocally(blob: Blob, progress: Progress, language: VoiceLanguage = 'english'): Promise<string> {
  progress('Preparing the recording on this device…');
  const audioContext = new AudioContext();
  let samples: Float32Array;
  try {
    const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.ceil(decoded.duration * 16000);
    const offline = new OfflineAudioContext(1, frames, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    samples = new Float32Array(rendered.getChannelData(0));
  } finally { await audioContext.close().catch(() => undefined); }
  if (!samples.length) throw new Error('The recording has no audio to transcribe.');
  const id = ++nextId;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject, progress });
    try { getWorker().postMessage({ id, samples, language }, [samples.buffer]); }
    catch (error) { pending.delete(id); reject(error as Error); }
  });
}
