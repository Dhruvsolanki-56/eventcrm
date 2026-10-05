import { useId } from 'react';

/** The Encore mark: a loop that turns back into an E, with a gold spotlight for the second conversation. */
export function BrandMark({ size = 26 }: { size?: number }) {
  // Every copy of the mark needs its own gradient id; two copies sharing one is invalid, and hiding one would blank the other.
  const tile = `encore-tile-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return <svg className="brand-mark" width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
    <defs><linearGradient id={tile} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2f5d50" /><stop offset="1" stopColor="#16231f" /></linearGradient></defs>
    <rect width="512" height="512" rx="120" fill={`url(#${tile})`} />
    <path d="M352 180A118 118 0 1 0 352 332M178 256H292" fill="none" stroke="#fff" strokeWidth="44" strokeLinecap="round" />
    <circle cx="356" cy="256" r="26" fill="#e3c27a" />
  </svg>;
}

export const brandName = 'Encore';
