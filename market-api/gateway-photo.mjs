export const GATEWAY_PHOTO_LIMIT = 2_000_000;
let active = 0;

export async function gatewayPhotoSlot(task) {
  if (active >= 2) throw Object.assign(new Error('gateway_photo_busy'), { status: 503 });
  active++;
  try { return await task(); } finally { active--; }
}

// Decode the existing image into a separate response; never rewrite stored files.
export async function gatewayJpeg(sharp, input) {
  for (const side of [1600, 1280, 1024]) {
    for (const quality of [82, 68, 52]) {
      const jpeg = await sharp(input, { failOn: 'warning', limitInputPixels: 16_000_000 })
        .rotate().resize(side, side, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true }).toBuffer();
      if (jpeg.length <= GATEWAY_PHOTO_LIMIT) return jpeg;
    }
  }
  throw new Error('gateway_photo_size');
}
