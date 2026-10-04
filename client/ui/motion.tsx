import { useEffect, useRef, useState } from 'react';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Counts up to a number once it is known, so a figure feels like it arrived instead of just appearing. */
export function useCountUp(target: number | undefined, duration = 700) {
  const [value, setValue] = useState<number | undefined>(target === undefined || reduced() ? target : 0);
  const from = useRef(0);
  useEffect(() => {
    if (target === undefined) { setValue(undefined); return; }
    if (reduced() || from.current === target) { setValue(target); from.current = target; return; }
    const start = performance.now(); const begin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(begin + (target - begin) * eased));
      if (progress < 1) frame = requestAnimationFrame(tick); else from.current = target;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return value;
}

export function CountUp({ value }: { value: number | undefined }) {
  const shown = useCountUp(value);
  return <>{shown === undefined ? '—' : shown}</>;
}

/** A greeting that matches the time of day. */
export function greetingFor(date = new Date()) {
  const hour = date.getHours();
  return hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}
