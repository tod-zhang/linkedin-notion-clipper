// Download LinkedIn images so they can be re-hosted in Notion. LinkedIn media
// URLs are signed and expire, so linking them directly would break later.

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // Notion free-plan per-file limit
const SINGLE_PART_LIMIT = 20 * 1024 * 1024; // larger files need multi-part uploads

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
};

/** Identify an image type from its first bytes when the Content-Type is unhelpful. */
export function sniffImageType(bytes) {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand.startsWith('avi')) return 'image/avif';
    if (brand.startsWith('hei') || brand.startsWith('mif')) return 'image/heic';
  }
  return null;
}

export function extensionFor(contentType) {
  return EXTENSIONS[contentType] || null;
}

/**
 * Try each candidate URL (largest first) and return the first image within the
 * free-plan limit: {blob, contentType, filename, url}. If every size is over
 * it, return the smallest one up to Notion's 20 MiB single-part limit (paid
 * plans accept it; on free plans the upload fails and the caller falls back).
 * Returns null if nothing usable downloads.
 */
export async function downloadImage(sources, baseName, { fetchImpl, maxBytes = MAX_UPLOAD_BYTES } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let oversized = null;
  for (const url of sources) {
    try {
      const res = await doFetch(url, { credentials: 'omit' });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > SINGLE_PART_LIMIT) continue;
      const header = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      const contentType = extensionFor(header) ? header : sniffImageType(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)));
      if (!contentType) continue;
      const file = { blob: new Blob([buf], { type: contentType }), contentType, filename: `${baseName}.${extensionFor(contentType)}`, url };
      if (buf.byteLength <= maxBytes) return file;
      if (!oversized || buf.byteLength < oversized.blob.size) oversized = file;
    } catch {
      // try the next size
    }
  }
  return oversized;
}
