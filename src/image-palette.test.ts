import {Jimp} from 'jimp';
import {describe, expect, it} from 'vitest';
import {suggestPaletteFromImage} from './image-palette.js';
import {VIDEO_PALETTES} from './visual-palettes.js';

const solidColorPng = async (hex: string): Promise<Buffer> => {
  const color = Number.parseInt(`${hex.replace(/^#/u, '')}ff`, 16);
  const image = new Jimp({color, height: 8, width: 8});
  return image.getBuffer('image/png');
};

describe('suggestPaletteFromImage', () => {
  it.each(Object.entries(VIDEO_PALETTES))(
    'suggests the %s palette for a solid image in its own accent color',
    async (palette, definition) => {
      const bytes = await solidColorPng(definition.accents.primary);
      await expect(suggestPaletteFromImage(bytes, 'image/png')).resolves.toBe(palette);
    },
  );

  it('returns undefined for a near-grayscale image', async () => {
    const bytes = await solidColorPng('#808080');
    await expect(suggestPaletteFromImage(bytes, 'image/png')).resolves.toBeUndefined();
  });

  it('returns undefined for WebP, which needs a Node-incompatible WASM loader to decode', async () => {
    const bytes = Buffer.from('RIFFxxxxWEBP');
    await expect(suggestPaletteFromImage(bytes, 'image/webp')).resolves.toBeUndefined();
  });

  it('returns undefined instead of throwing for bytes a full decoder rejects', async () => {
    const bytes = Buffer.from('not a real png');
    await expect(suggestPaletteFromImage(bytes, 'image/png')).resolves.toBeUndefined();
  });

  it('ignores fully transparent pixels when averaging', async () => {
    const image = new Jimp({color: 0x00000000, height: 4, width: 4});
    const bytes = await image.getBuffer('image/png');
    await expect(suggestPaletteFromImage(bytes, 'image/png')).resolves.toBeUndefined();
  });
});
