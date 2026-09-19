import {Jimp} from 'jimp';
import {VIDEO_PALETTES, type VideoPalette} from './visual-palettes.js';

interface Hsl {
  h: number;
  l: number;
  s: number;
}

const hexToHsl = (hex: string): Hsl => {
  const value = Number.parseInt(hex.replace(/^#/u, ''), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return {h: 0, l, s: 0};
  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const h = 60 * (
    max === r ? ((g - b) / delta + (g < b ? 6 : 0)) :
    max === g ? (b - r) / delta + 2 :
    (r - g) / delta + 4
  );
  return {h, l, s};
};

const hueDistance = (left: number, right: number): number => {
  const diff = Math.abs(left - right) % 360;
  return diff > 180 ? 360 - diff : diff;
};

/** Formats that decode without a Node-incompatible WASM loader; see docs/troubleshooting.md. */
const DECODABLE_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

/**
 * Suggests one of the fixed video palettes whose accent color is nearest in hue to a
 * background image's average color. Returns undefined when the image can't be decoded
 * (WebP) or has no clear dominant hue (near-grayscale), so callers keep the text-derived
 * palette instead of guessing.
 */
export const suggestPaletteFromImage = async (
  bytes: Buffer,
  mimeType: string,
): Promise<VideoPalette | undefined> => {
  if (!DECODABLE_MIME_TYPES.has(mimeType)) return undefined;

  let image;
  try {
    image = await Jimp.read(bytes);
  } catch {
    // An image that passes the lightweight format/signature check but a full decoder rejects
    // (unusual encoder, truncated data) should fall back to the text-derived palette, not fail
    // the whole --background-image flow over a best-effort color hint.
    return undefined;
  }
  const {data, height, width} = image.bitmap;
  const totalPixels = width * height;
  const sampleStride = Math.max(1, Math.floor(totalPixels / 4_096));

  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let sampled = 0;
  for (let pixel = 0; pixel < totalPixels; pixel += sampleStride) {
    const offset = pixel * 4;
    const alpha = data[offset + 3] ?? 255;
    if (alpha < 16) continue;
    redSum += data[offset] ?? 0;
    greenSum += data[offset + 1] ?? 0;
    blueSum += data[offset + 2] ?? 0;
    sampled += 1;
  }
  if (sampled === 0) return undefined;

  const averageHex = `#${[redSum, greenSum, blueSum]
    .map((sum) => Math.round(sum / sampled).toString(16).padStart(2, '0'))
    .join('')}`;
  const average = hexToHsl(averageHex);
  if (average.s < 0.12) return undefined;

  let bestPalette: VideoPalette | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [palette, definition] of Object.entries(VIDEO_PALETTES) as Array<[VideoPalette, typeof VIDEO_PALETTES[VideoPalette]]>) {
    const distance = hueDistance(average.h, hexToHsl(definition.accents.primary).h);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPalette = palette;
    }
  }
  return bestPalette;
};
