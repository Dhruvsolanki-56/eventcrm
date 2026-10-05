type Variant = 'table' | 'board' | 'detail' | 'tiles' | 'form' | 'list';

const bar = (width: string, className = '') => <span className={`sk ${className}`.trim()} style={{ width }} />;

/** A quiet outline of the page while its data loads, so the layout does not jump when the real content arrives. */
export function Skeleton({ variant, label, rows = 6 }: { variant: Variant; label: string; rows?: number }) {
  const widths = ['62%', '48%', '70%', '55%', '66%', '44%', '58%', '52%'];
  return <div className={`skeleton skeleton-${variant}`} role="status" aria-label={label}>
    {variant === 'table' && <div className="sk-card">
      <div className="sk-table-head">{bar('18%')}{bar('12%')}{bar('10%')}{bar('10%')}</div>
      {Array.from({ length: rows }, (_, index) => <div className="sk-table-row" key={index}>
        <span className="sk sk-circle" /><span className="sk-lines">{bar(widths[index % widths.length]!)}{bar('34%', 'sk-thin')}</span>{bar('14%')}{bar('9%', 'sk-pill')}{bar('8%')}
      </div>)}
    </div>}
    {variant === 'board' && <div className="sk-board">{Array.from({ length: 6 }, (_, lane) => <div className="sk-lane" key={lane}>
      {bar('40%', 'sk-thin')}
      {Array.from({ length: Math.max(1, 4 - (lane % 4)) }, (_, card) => <div className="sk-board-card" key={card}>{bar(widths[(lane + card) % widths.length]!)}{bar('46%', 'sk-thin')}</div>)}
    </div>)}</div>}
    {variant === 'detail' && <>
      <div className="sk-detail-head"><span className="sk sk-circle sk-large" /><span className="sk-lines">{bar('220px', 'sk-title')}{bar('160px', 'sk-thin')}</span></div>
      <div className="sk-detail-grid">
        <div className="sk-detail-main"><div className="sk-card sk-pad">{bar('30%')}{bar('100%', 'sk-box')}{bar('40%', 'sk-thin')}</div><div className="sk-card sk-pad">{bar('22%')}{Array.from({ length: 4 }, (_, index) => <span className="sk-lines" key={index}>{bar(widths[index]!)}{bar('24%', 'sk-thin')}</span>)}</div></div>
        <div className="sk-card sk-pad">{bar('36%')}{Array.from({ length: 5 }, (_, index) => <span className="sk-pair" key={index}>{bar('28%', 'sk-thin')}{bar('52%', 'sk-thin')}</span>)}</div>
      </div>
    </>}
    {variant === 'tiles' && <div className="sk-tiles">{Array.from({ length: rows }, (_, index) => <div className="sk-card sk-pad" key={index}>{bar('42%', 'sk-thin')}{bar('30%', 'sk-title')}</div>)}</div>}
    {variant === 'form' && <div className="sk-card">{Array.from({ length: 3 }, (_, index) => <div className="sk-form-row" key={index}>
      <span className="sk-lines">{bar('60%')}{bar('84%', 'sk-thin')}</span>
      <span className="sk-lines">{bar('30%', 'sk-thin')}{bar('100%', 'sk-input')}{bar('30%', 'sk-thin')}{bar('100%', 'sk-input')}</span>
    </div>)}</div>}
    {variant === 'list' && <div className="sk-list">{Array.from({ length: rows }, (_, index) => <div className="sk-card sk-list-row" key={index}>
      <span className="sk sk-circle sk-small" /><span className="sk-lines">{bar(widths[index % widths.length]!)}{bar('38%', 'sk-thin')}</span>{bar('120px', 'sk-pill')}
    </div>)}</div>}
  </div>;
}
