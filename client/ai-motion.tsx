import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import './ai-motion.css';

/** True for `ms` after `active` turns from true to false, so a result can briefly highlight itself. */
export function useJustFinished(active: boolean, ms = 2000, resetKey?: string) {
  const [flash, setFlash] = useState(false);
  const was = useRef(false);
  useEffect(() => { was.current = false; setFlash(false); }, [resetKey]);
  useEffect(() => {
    if (active) { was.current = true; setFlash(false); return; }
    if (!was.current) return;
    was.current = false;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), ms);
    return () => window.clearTimeout(timer);
  }, [active, ms]);
  return flash;
}

type AiWritingBarProps = {
  /** The AI is still working. */
  writing: boolean;
  /** The person has started typing, so the AI will leave their text alone. */
  tookOver?: boolean;
  /** The AI just replaced the draft. */
  arrived?: boolean;
  title?: string;
};

/** A live status bar for an AI-written draft. It only states what is really happening. */
export function AiWritingBar({ writing, tookOver = false, arrived = false, title = 'AI is writing a better version' }: AiWritingBarProps) {
  if (!writing && !arrived) return null;
  const mode = arrived ? 'is-done' : tookOver ? 'is-calm' : '';
  return <div className={`ai-bar ${mode}`.trim()} role="status" aria-live="polite">
    <Sparkles size={18} aria-hidden="true" />
    <div>
      {arrived ? <><strong>The AI draft is ready</strong><span>Read it against the conversation, then edit anything you like.</span></>
        : tookOver ? <><strong>You are editing</strong><span>The AI is still working, but it will not replace your text.</span></>
        : <><strong>{title}<span className="ai-dots" aria-hidden="true" /></strong><span>The template draft below stays here until it is ready. Start typing any time and your text is kept.</span></>}
    </div>
  </div>;
}

/** Placeholder lines shown while the first draft is being created. */
export function AiDraftSkeleton({ label = 'Preparing your draft' }: { label?: string }) {
  return <div role="status" aria-live="polite">
    <div className="ai-bar"><Sparkles size={18} aria-hidden="true" /><div><strong>{label}<span className="ai-dots" aria-hidden="true" /></strong><span>Reading your saved conversation. This takes a few seconds.</span></div></div>
    <div className="ai-skeleton" aria-hidden="true"><i /><i /><i /><i /></div>
  </div>;
}
