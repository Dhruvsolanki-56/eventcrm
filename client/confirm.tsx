import { useEffect, useRef, useState } from 'react';

export type ConfirmOptions = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type Pending = ConfirmOptions & { resolve: (answer: boolean) => void };

let show: ((pending: Pending) => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** In-app replacement for window.confirm. Resolves true on confirm, false on cancel, Escape or backdrop click. Several requests at once are shown one after another. */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  const ask = () => new Promise<boolean>((resolve) => {
    if (!show) { resolve(window.confirm([options.title, options.body].filter(Boolean).join('\n\n'))); return; }
    show({ ...options, resolve });
  });
  const answer = queue.then(ask);
  queue = answer.catch(() => undefined);
  return answer;
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    show = (next) => { opener.current = document.activeElement as HTMLElement | null; setPending(next); };
    return () => { show = null; };
  }, []);

  useEffect(() => { if (pending) cancelRef.current?.focus(); }, [pending]);

  function finish(answer: boolean) {
    pending?.resolve(answer);
    setPending(null);
    window.setTimeout(() => opener.current?.focus?.(), 0);
  }

  if (!pending) return null;
  return <div className="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(false); }}>
    <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={pending.body ? 'confirm-body' : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); finish(false); }
        if (event.key === 'Tab') {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
          const first = buttons[0]; const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <h2 id="confirm-title">{pending.title}</h2>
      {pending.body && <p id="confirm-body">{pending.body}</p>}
      <div className="confirm-actions">
        <button type="button" ref={cancelRef} className="button secondary" onClick={() => finish(false)}>{pending.cancelLabel ?? 'Cancel'}</button>
        <button type="button" className={`button ${pending.danger ? 'danger' : 'primary'}`} data-confirm-accept onClick={() => finish(true)}>{pending.confirmLabel ?? 'Continue'}</button>
      </div>
    </div>
  </div>;
}
