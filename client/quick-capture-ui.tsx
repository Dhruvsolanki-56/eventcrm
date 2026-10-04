import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { transcribeLocally, type VoiceLanguage } from './local-transcribe.js';
import { hasSentence, outcomeChips, productChips, toggleSentence } from './quick-capture.js';
import './quick-capture.css';

/** One-tap choices that write plain sentences into the note. The person can still type anything. */
export function NoteChips({ value, onChange, productNames = [] }: { value: string; onChange: (next: string) => void; productNames?: string[] }) {
  const chips = [...outcomeChips, ...productChips(productNames)];
  return <div className="note-chips" role="group" aria-label="Tap what happened">
    <span className="note-chips-label">Tap what happened</span>
    <div className="note-chips-row">
      {chips.map((chip) => {
        const on = hasSentence(value, chip.sentence);
        return <button type="button" key={chip.sentence} className={`quick-chip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => onChange(toggleSentence(value, chip.sentence))}>{chip.label}</button>;
      })}
    </div>
  </div>;
}

const languages: Array<{ id: VoiceLanguage; label: string }> = [{ id: 'english', label: 'English' }, { id: 'hindi', label: 'Hindi' }, { id: 'gujarati', label: 'Gujarati' }];

/** Speak instead of typing. The audio is turned into text on this device and is not saved; the person checks the text. */
export function DictateButton({ onText, disabled = false }: { onText: (text: string) => void; disabled?: boolean }) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState('');
  const [message, setMessage] = useState('');
  const [language, setLanguage] = useState<VoiceLanguage>('english');
  const supported = typeof window !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';

  useEffect(() => () => { streamRef.current?.getTracks().forEach((track) => track.stop()); }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setSeconds((value) => {
      if (value >= 89) { recorderRef.current?.stop(); return 90; }
      return value + 1;
    }), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  async function start() {
    setMessage(''); setSeconds(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder; chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop()); streamRef.current = null; setRecording(false);
        if (blob.size) void write(blob); else setMessage('Nothing was recorded. Try again or type your note.');
      };
      recorder.start(500); setRecording(true);
    } catch { setMessage('The microphone is not available. Type your note instead.'); }
  }
  function stop() { if (recorderRef.current?.state === 'recording') recorderRef.current.stop(); }
  async function write(blob: Blob) {
    setProgress('Preparing…');
    try {
      const text = await transcribeLocally(blob, setProgress, language);
      if (!text.trim()) { setMessage('No speech was found. Try again or type your note.'); return; }
      onText(text);
      setMessage('Written from your voice. Check it and fix any mistakes. The audio was not saved.');
    } catch (issue) { setMessage((issue as Error).message); }
    finally { setProgress(''); }
  }

  if (!supported) return null;
  const working = Boolean(progress);
  return <div className="dictate">
    <div className="dictate-row">
      {recording
        ? <button type="button" className="button secondary dictate-stop" onClick={stop}><Square size={14} aria-hidden="true" /> Stop and write it down · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</button>
        : <button type="button" className="button secondary dictate-start" disabled={disabled || working} onClick={() => void start()}><Mic size={15} aria-hidden="true" /> {working ? 'Writing it down…' : 'Speak instead of typing'}</button>}
      {!recording && !working && <label className="dictate-language"><span className="sr-only">Language you will speak</span><select value={language} onChange={(event) => setLanguage(event.target.value as VoiceLanguage)}>{languages.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
    </div>
    {recording && <span className="dictate-live" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
    {(working || message) && <p className="dictate-note" role="status">{working ? progress : message}</p>}
  </div>;
}
