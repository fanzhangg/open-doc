// Pictures a doc shows from its own folder, read so an export carries them
// inside the file. Only image files are read; anything else stays a link.

import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * The picture at `url` as written in the doc at `docPath`, when it is a file
 * next to the doc: { data, type, width, height } (size in pixels, null when
 * unknown), or null for web addresses and anything that is not an image.
 */
export async function readLocalImage(docPath, url) {
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return null;
  let path;
  try {
    path = resolve(dirname(docPath), decodeURI(url.replace(/[?#].*$/, '')));
  } catch {
    return null;
  }
  const type = TYPES[extname(path).toLowerCase()];
  if (!type) return null;
  try {
    if ((await stat(path)).size > MAX_BYTES) return null;
    const data = await readFile(path);
    return { data, type, ...imageSize(data, type) };
  } catch {
    return null;
  }
}

export const dataUri = (image) => `data:${image.type};base64,${image.data.toString('base64')}`;

/** Pixel size of a PNG, JPEG or GIF from its header. */
export function imageSize(data, type) {
  try {
    if (type === 'image/png' && data.length >= 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (type === 'image/gif' && data.length >= 10) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < data.length) {
        if (data[i] !== 0xff) return { width: null, height: null };
        const marker = data[i + 1];
        const length = data.readUInt16BE(i + 2);
        // Start-of-frame markers, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
        }
        i += 2 + length;
      }
    }
  } catch {
    // a broken header: size unknown
  }
  return { width: null, height: null };
}
