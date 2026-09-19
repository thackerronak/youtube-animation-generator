import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readLocalImage} from './local-images.js';
import {suggestPaletteFromImage} from './image-palette.js';
import type {VideoPalette} from './visual-palettes.js';

export interface ImageBackground {
  filePath: string;
  sha256: string;
  /** Nearest fixed palette to the image's average color; undefined for WebP or near-grayscale images. */
  suggestedPalette?: VideoPalette;
}

export const validateImageBackground = async (path: string): Promise<ImageBackground> => {
  if (!path.trim()) throw new Error('--background-image requires a local image path.');
  const filePath = resolve(path);
  try {
    const {bytes, mimeType, sha256} = await readLocalImage(filePath);
    const suggestedPalette = await suggestPaletteFromImage(bytes, mimeType);
    return {filePath, sha256, ...(suggestedPalette ? {suggestedPalette} : {})};
  } catch (error) {
    throw new Error(`Invalid --background-image: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
  }
};

/** Overrides a plan's text-derived palette with the one suggested by its background image, if any. */
export const applyImageBackgroundPalette = <Plan extends {palette: VideoPalette}>(
  plan: Plan,
  imageBackground: ImageBackground | undefined,
): Plan => (
  imageBackground?.suggestedPalette && imageBackground.suggestedPalette !== plan.palette
    ? {...plan, palette: imageBackground.suggestedPalette}
    : plan
);

/** Copy the validated bytes once; every scene and orientation shares this public asset. */
export const stageImageBackground = async (
  image: ImageBackground | undefined,
  publicDirectory: string,
): Promise<string> => {
  if (!image) throw new Error('Image background requires --background-image <path>.');
  const {bytes, mimeType, sha256} = await readLocalImage(image.filePath);
  if (sha256 !== image.sha256) {
    throw new Error(`Background image changed after validation: ${image.filePath}. Run the command again.`);
  }
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const publicName = `background-image-${sha256}.${extension}`;
  await writeFile(resolve(publicDirectory, publicName), bytes);
  return publicName;
};
