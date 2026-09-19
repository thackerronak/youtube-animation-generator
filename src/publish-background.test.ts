import {access, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {relative, resolve} from 'node:path';
import {Jimp} from 'jimp';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition} from '@remotion/renderer';
import {runCli} from './cli.js';
import {generateNarratedPublishPlan} from './publish.js';
import {narratedPublishPlanSchema, publishCoverInputSchema} from './types.js';
import {VIDEO_PALETTES} from './visual-palettes.js';

const solidColorPng = async (hex: string): Promise<Buffer> => {
  const color = Number.parseInt(`${hex.replace(/^#/u, '')}ff`, 16);
  const image = new Jimp({color, height: 8, width: 8});
  return image.getBuffer('image/png');
};

vi.mock('@remotion/bundler', () => ({bundle: vi.fn()}));
vi.mock('@remotion/renderer', () => ({renderStill: vi.fn(), selectComposition: vi.fn()}));
vi.mock('./publish.js', async (original) => ({
  ...await original<typeof import('./publish.js')>(),
  generateNarratedPublishPlan: vi.fn(),
}));

const directories: string[] = [];
const stagedBytes: Buffer[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0mQAAAAASUVORK5CYII=', 'base64');
const setup = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'publish-background-test-'));
  directories.push(directory);
  const planPath = resolve(directory, 'summary.narration-plan.json');
  const publishPath = resolve(directory, 'saved.publish.json');
  const imagePath = resolve(directory, 'My Background.png');
  const publish = narratedPublishPlanSchema.parse(JSON.parse(await readFile('fixtures/sample.publish.json', 'utf8')));
  await writeFile(planPath, await readFile('fixtures/sample.narration-plan.json'));
  await writeFile(publishPath, JSON.stringify(publish));
  await writeFile(imagePath, png);
  vi.mocked(generateNarratedPublishPlan).mockResolvedValue(publish);
  return {directory, planPath, publishPath, imagePath, publish};
};

beforeEach(() => {
  vi.mocked(bundle).mockImplementation(async ({publicDir}) => {
    for (const file of await readdir(publicDir!)) {
      if (file.startsWith('background-image-')) stagedBytes.push(await readFile(resolve(publicDir!, file)));
    }
    return '/unused-test-bundle';
  });
  vi.mocked(selectComposition).mockResolvedValue({id: 'NarratedThumbnail'} as Awaited<ReturnType<typeof selectComposition>>);
  vi.mocked(renderStill).mockImplementation(async ({output}) => {
    await writeFile(output!, png);
    return {buffer: null};
  });
});

afterEach(async () => {
  vi.resetAllMocks();
  stagedBytes.length = 0;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
});

describe('publish image backgrounds', () => {
  it.each(['16:9', '9:16', 'both'])('rerenders saved metadata in %s with one unchanged staged image', async (aspect) => {
    const {directory, planPath, publishPath, imagePath} = await setup();
    await runCli(['publish', planPath, '--render-publish', publishPath, '--cover-aspect', aspect,
      '--background-image', relative(process.cwd(), imagePath)]);
    expect(generateNarratedPublishPlan).not.toHaveBeenCalled();
    expect(stagedBytes).toEqual([png]);
    expect(renderStill).toHaveBeenCalledTimes(aspect === 'both' ? 2 : 1);
    const assets = new Set<string>();
    const aspects: string[] = [];
    for (const [options] of vi.mocked(renderStill).mock.calls) {
      const input = publishCoverInputSchema.parse(options.inputProps);
      expect(input.backgroundImageAsset).toMatch(/^background-image-[a-f0-9]{64}\.png$/u);
      assets.add(input.backgroundImageAsset!);
      aspects.push(input.profile.aspectRatio);
    }
    expect(assets.size).toBe(1);
    expect(aspects).toEqual(aspect === 'both' ? ['16:9', '9:16'] : [aspect]);
    if (aspect === 'both') {
      expect(renderStill).toHaveBeenNthCalledWith(1, expect.objectContaining({output: resolve(directory, 'summary.thumbnail.png')}));
      expect(renderStill).toHaveBeenNthCalledWith(2, expect.objectContaining({output: resolve(directory, 'summary.cover-9x16.png')}));
    }
    await expect(access(vi.mocked(bundle).mock.calls[0]![0].publicDir!)).rejects.toThrow();
    expect(JSON.parse(await readFile(publishPath, 'utf8'))).not.toHaveProperty('backgroundImageAsset');
  });

  it('passes the image through new metadata generation and retains overwrite protection', async () => {
    const {planPath, imagePath} = await setup();
    const args = ['publish', planPath, '--background-image', imagePath];
    await runCli(args);
    expect(generateNarratedPublishPlan).toHaveBeenCalledTimes(1);
    expect(stagedBytes).toEqual([png]);
    await expect(runCli(args)).rejects.toThrow('Output already exists');
    expect(generateNarratedPublishPlan).toHaveBeenCalledTimes(1);
    await runCli([...args, '--force']);
    expect(generateNarratedPublishPlan).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('validates metadata-only images without bundling or staging (saved=%s)', async (saved) => {
    const {planPath, publishPath, imagePath} = await setup();
    const args = ['publish', planPath, '--metadata-only', ...(saved ? ['--render-publish', publishPath] : [])];
    await expect(runCli([...args, '--background-image', `${imagePath}.missing.png`])).rejects.toThrow('Invalid --background-image');
    expect(generateNarratedPublishPlan).not.toHaveBeenCalled();
    await runCli([...args, '--background-image', imagePath]);
    expect(generateNarratedPublishPlan).toHaveBeenCalledTimes(saved ? 0 : 1);
    expect(bundle).not.toHaveBeenCalled();
    expect(renderStill).not.toHaveBeenCalled();
    expect(stagedBytes).toEqual([]);
  });

  it('rejects conflicting image options before generation', async () => {
    const {planPath, imagePath} = await setup();
    for (const mode of ['off', 'ambient', 'generated']) {
      await expect(runCli(['publish', planPath, '--background-image', imagePath, '--scene-background', mode]))
        .rejects.toThrow('cannot be combined');
    }
    await expect(runCli(['publish', planPath, '--scene-background', 'image'])).rejects.toThrow('requires --background-image');
    await expect(runCli(['publish', planPath, '--background-image', imagePath, '--regenerate-backgrounds']))
      .rejects.toThrow('--regenerate-backgrounds requires');
    expect(generateNarratedPublishPlan).not.toHaveBeenCalled();
  });

  it('rejects an image modified during metadata generation before bundling', async () => {
    const {planPath, imagePath, publish} = await setup();
    vi.mocked(generateNarratedPublishPlan).mockImplementation(async () => {
      await writeFile(imagePath, Buffer.concat([png, Buffer.from('modified')]));
      return publish;
    });
    await expect(runCli(['publish', planPath, '--background-image', imagePath])).rejects.toThrow('changed after validation');
    expect(bundle).not.toHaveBeenCalled();
    expect(renderStill).not.toHaveBeenCalled();
  });

  it('cleans up the staged image when rendering fails', async () => {
    const {planPath, publishPath, imagePath} = await setup();
    vi.mocked(renderStill).mockRejectedValueOnce(new Error('Image decoding failed'));
    await expect(runCli(['publish', planPath, '--render-publish', publishPath, '--background-image', imagePath]))
      .rejects.toThrow('Image decoding failed');
    await expect(access(vi.mocked(bundle).mock.calls[0]![0].publicDir!)).rejects.toThrow();
  });

  it('overrides the saved thumbnail accent using a decodable background image', async () => {
    const {planPath, publishPath, imagePath} = await setup();
    await writeFile(imagePath, await solidColorPng(VIDEO_PALETTES.violet.accents.primary));
    await runCli(['publish', planPath, '--render-publish', publishPath, '--background-image', imagePath]);
    for (const [options] of vi.mocked(renderStill).mock.calls) {
      const input = publishCoverInputSchema.parse(options.inputProps);
      expect(input.publish.thumbnail.accent).toBe('violet');
    }
  });

  it('keeps legacy props and the palette backdrop when no image is supplied', async () => {
    const {planPath, publishPath} = await setup();
    await runCli(['publish', planPath, '--render-publish', publishPath]);
    expect(stagedBytes).toEqual([]);
    for (const [options] of vi.mocked(renderStill).mock.calls) {
      const input = publishCoverInputSchema.parse(options.inputProps);
      expect(input.backgroundImageAsset).toBeUndefined();
      expect(input.publish.thumbnail.accent).toBe('cyan');
    }
  });
});
