import {Jimp} from 'jimp';
import {withTransientImageRetries, type GenerateSceneImage} from '../scene-backgrounds.js';

// Workers AI models do not share a parameter set, and sending the wrong one is
// a 400 rather than a warning. Two families matter here:
//   flux-1-schnell            prompt (<=2048 chars), steps (<=8), seed.
//                             NO width/height - it returns a square - and NO
//                             negative_prompt. Responds with base64 in JSON.
//   stable-diffusion-xl-*     prompt, negative_prompt, width/height (256-2048),
//                             num_steps (<=20), guidance, seed.
//                             Responds with a raw image stream.
// The square plate is why generated backgrounds never fitted a 16:9 frame:
// objectFit:cover cropped ~42% of the height away before anything drew over it.
const FLUX_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const DEFAULT_MODEL = '@cf/stabilityai/stable-diffusion-xl-base-1.0';

const FLUX_MAX_PROMPT = 2_048;
const FLUX_MAX_STEPS = 8;
const SDXL_STEPS = 20;
/** SDXL is trained at ~1 megapixel; 1344 on the long edge is its 16:9 sweet
 *  spot. Larger is accepted but degrades composition. */
const SDXL_MAX_EDGE = 1_344;

/**
 * Turn the `"2048x1152"` size the pipeline already computes into dimensions
 * Workers AI accepts: aspect preserved, long edge capped, snapped to a multiple
 * of 8, clamped to the documented 256-2048 range. Returns null for an
 * unparseable size so the caller can simply omit the parameter.
 */
export const cloudflareDimensions = (
  size: string,
  maxEdge: number = SDXL_MAX_EDGE,
): {height: number; width: number} | null => {
  const match = /^\s*(\d+)\s*x\s*(\d+)\s*$/u.exec(size);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const snap = (value: number): number =>
    Math.max(256, Math.min(2_048, Math.round((value * scale) / 8) * 8));
  return {height: snap(height), width: snap(width)};
};

const isSdxlFamily = (model: string): boolean => model.includes('stable-diffusion');

/**
 * SDXL's built-in safety checker can trip on an inoffensive prompt and, instead
 * of an error, Workers AI responds 200 with a fixed near-black placeholder
 * image (same bytes every time). withTransientImageRetries only guards against
 * an empty body, so that placeholder sails through as a "successful"
 * generation. This flags a near-black AND near-uniform image so the caller can
 * retry instead - no seed is sent, so a retry is not guaranteed to repeat the
 * block.
 */
const BLOCKED_IMAGE_MAX_MEAN_LUMINANCE = 10;
const BLOCKED_IMAGE_MAX_LUMINANCE_STD_DEV = 4;

const looksLikeBlockedPlaceholder = async (bytes: Buffer): Promise<boolean> => {
  let image;
  try {
    image = await Jimp.read(bytes);
  } catch {
    // Can't decode it here; let the caller's own validation (if any) decide.
    return false;
  }
  const {data, height, width} = image.bitmap;
  const totalPixels = width * height;
  if (!totalPixels) return false;
  const sampleStride = Math.max(1, Math.floor(totalPixels / 4_096));

  let sum = 0;
  let sumSquares = 0;
  let sampled = 0;
  for (let pixel = 0; pixel < totalPixels; pixel += sampleStride) {
    const offset = pixel * 4;
    const luminance = (data[offset] ?? 0) * 0.299
      + (data[offset + 1] ?? 0) * 0.587
      + (data[offset + 2] ?? 0) * 0.114;
    sum += luminance;
    sumSquares += luminance * luminance;
    sampled += 1;
  }
  if (!sampled) return false;
  const mean = sum / sampled;
  const variance = Math.max(0, sumSquares / sampled - mean * mean);
  return mean < BLOCKED_IMAGE_MAX_MEAN_LUMINANCE
    && Math.sqrt(variance) < BLOCKED_IMAGE_MAX_LUMINANCE_STD_DEV;
};

/** Exported for tests: the exact body we post for a given model. */
export const cloudflareImageBody = ({
  model,
  negativePrompt,
  prompt,
  size,
}: {
  model: string;
  negativePrompt?: string | undefined;
  prompt: string;
  size: string;
}): Record<string, unknown> => {
  if (model === FLUX_MODEL) {
    return {prompt: prompt.slice(0, FLUX_MAX_PROMPT), steps: FLUX_MAX_STEPS};
  }
  if (!isSdxlFamily(model)) return {prompt};
  const dimensions = cloudflareDimensions(size);
  return {
    ...(dimensions ?? {}),
    ...(negativePrompt ? {negative_prompt: negativePrompt} : {}),
    num_steps: SDXL_STEPS,
    prompt,
  };
};

export const createCloudflareImageGenerator = (): GenerateSceneImage => {
  const token = process.env.CLOUDFLARE_AI_KEY || process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!token || !accountId) {
    throw new Error(
      'CLOUDFLARE_AI_KEY (or CLOUDFLARE_API_TOKEN) and CLOUDFLARE_ACCOUNT_ID are required in your .env file for Cloudflare Workers AI image generation.',
    );
  }

  return async ({prompt, model, negativePrompt, size}) => withTransientImageRetries(
    async () => {
      const activeModel = model && model.startsWith('@cf/') ? model : DEFAULT_MODEL;
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${activeModel}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          cloudflareImageBody({model: activeModel, negativePrompt, prompt, size}),
        ),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(
          `Cloudflare image generation failed (${response.status}): ${errorText}`,
        );
        // withTransientImageRetries keys off status, and fetch does not set it.
        Object.assign(error, {status: response.status});
        throw error;
      }

      // SDXL-family models stream the image; flux returns base64 inside JSON.
      let bytes: Buffer;
      if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
        bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length) {
          throw new Error('Cloudflare image generation returned an empty image stream.');
        }
      } else {
        const data = await response.json() as {
          result?: {image?: string};
          success?: boolean;
          errors?: Array<{message?: string}>;
        };

        if (!data.result?.image) {
          const message = data.errors?.[0]?.message ?? 'No image data returned';
          throw new Error(`Cloudflare image generation returned no image: ${message}`);
        }

        bytes = Buffer.from(data.result.image, 'base64');
      }

      if (await looksLikeBlockedPlaceholder(bytes)) {
        const error = new Error(
          'Cloudflare image generation returned a blank placeholder image, likely blocked by '
          + "the model's safety filter.",
        );
        // Marked transient so withTransientImageRetries retries it - no seed is
        // sent, so a retry is not the same request.
        Object.assign(error, {status: 503});
        throw error;
      }

      return bytes;
    },
  );
};
