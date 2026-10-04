import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Builds heavy content (charts) only when it is about to be seen, and keeps its space so the page does not jump. */
export function WhenVisible({ children, className = '' }: { children: ReactNode; className?: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const node = holder.current;
    if (shown || !node) return;
    const watcher = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setShown(true); watcher.disconnect(); } }, { rootMargin: '240px' });
    watcher.observe(node);
    return () => watcher.disconnect();
  }, [shown]);
  return <div ref={holder} className={`when-visible ${className}`.trim()}>{shown ? children : null}</div>;
}
