import sharp from 'sharp';

// A small difference hash is a hint, never proof of identity. Only an explicit
// confirmation may reuse a visually similar card or brochure.
export async function imageDifferenceHash(image: Buffer): Promise<string> {
  const pixels = await sharp(image, { limitInputPixels: 24_000_000 })
    .rotate().resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
  let bits = 0n;
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      bits = (bits << 1n) | (pixels[row * 9 + column] > pixels[row * 9 + column + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function imageHashDistance(left: string, right: string): number {
  if (!/^[a-f0-9]{16}$/.test(left) || !/^[a-f0-9]{16}$/.test(right)) return 64;
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (difference) { count += Number(difference & 1n); difference >>= 1n; }
  return count;
}
