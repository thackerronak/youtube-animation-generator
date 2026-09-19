# Architecture

← [AGENTS.md](../AGENTS.md) · Verified 2026-09-16 at commit `d1e65f3`

## Design intent

Three capabilities are deliberately decoupled so each runs independently:

| Capability | Implementation | External dependency |
|---|---|---|
| **Authoring** — what the video says and shows | OpenAI, Gemini, or Groq | Provider key, network, billed |
| **Speech** — script into audio | Supertonic 3, ONNX, on-CPU | Local model files only |
| **Rendering** — plan into frames | Remotion → React → headless Chrome | Local Chrome only |

Speech and rendering are fully offline. Only authoring needs a key, and *which* provider
supplies it is configurable — see [providers.md](providers.md).

## Pipeline topology

```
                    ┌───────────── requires an AI provider key ─────────────┐
                    │                                                        │
  source.md ────────┼──► narration-planner.ts ──► draft plan (JSON) ◄────────┼─── hand-authored
  subtitle.srt ─────┼──► planner.ts          ──► draft plan (JSON)           │    or edited
                    │                                                        │
                    └────────────────────────────────────────────────────────┘
                                              │
                    ┌─────────────────────────┴──────── fully offline ───────┐
                    │                                                         │
                    ▼                                                         │
            narration-audio.ts                                                │
        (spawns supertonic/worker.ts)                                         │
                    │                                                         │
        ┌───────────┴────────────┐                                            │
        ▼                        ▼                                            │
  voiceover.wav          timed plan (JSON)                                    │
        │                        │                                            │
        └───────────┬────────────┘                                            │
                    ▼                                                         │
            narrated-render.ts ──► Remotion bundle ──► headless Chrome ──► .mp4
                    │                                                         │
                    └─────────────────────────────────────────────────────────┘
```

## Egress inventory

Every billed network call originates from one of these. Authoritative check:

```bash
grep -rn "new OpenAI(\|createAIClient(\|fetch(" src/ --include='*.ts' | grep -v test
```

**Script generation** goes through the `createAIClient` abstraction (`src/ai-client.ts`), which
returns an `openai` SDK client pointed at OpenAI, Gemini, or Groq:

| Call site | Triggered by | Cost class |
|---|---|---|
| `src/narration-planner.ts:545` | `create <source.md>` | Tokens |
| `src/planner.ts:509` | `<subtitle.srt>` without `--render-plan` | Tokens |
| `src/publish.ts:160` | `publish <plan.json>` | Tokens |
| `src/topic-author.ts` | `topic "<name>"` | Tokens |

**Direct clients** bypass the abstraction, deliberately:

| Call site | Triggered by | Provider | Why direct |
|---|---|---|---|
| `src/scene-backgrounds.ts:147` | `--scene-background generated` | OpenAI Images | Image API, not chat |
| `src/providers/cloudflare-image.ts:19` | `--scene-background generated` | Cloudflare (`fetch`) | Workers AI REST |
| `src/generated-visuals.ts:182` | `--generated-visuals auto` | OpenAI vision | Validator |
| `src/generated-visuals.ts:219` | `--generated-visuals auto` | Gemini vision | Validator |
| `src/source-research.ts:217` | `--research auto\|required` | **OpenAI only** | Hosted `web_search` tool has no compat equivalent |

Provider clients throw when their key is unset (`ai-client.ts:44-77`). If a command exits 0
with no provider keys in the environment, it provably made no billed call.

Resolution order, API-surface differences, and env vars: [providers.md](providers.md).

## Repository layout

```
src/
  cli.ts                  Arg parsing and dispatch. Usage text at :70-140. Entry point.
  types.ts                ~2,000 lines of Zod schemas. Source of truth for all file formats.

  ai-client.ts            Provider abstraction + transient-retry helper
  schema-prompt.ts        Renders a JSON Schema as a terse signature for providers
                          that receive the response shape in the prompt
  providers/
    cloudflare-image.ts   Cloudflare Workers AI (FLUX.1) image generation

  topic-author.ts         Writes a source document from a topic name, validated
                          against what the planner will later demand of it
  planner.ts              Subtitle-overlay authoring (AI provider)
  narration-planner.ts    Narrated-video authoring (AI provider)
  source-research.ts      Optional grounded web research (OpenAI only)
  publish.ts              Publish-kit metadata authoring (AI provider)
  scene-backgrounds.ts    Background image generation + image-provider routing
  generated-visuals.ts    Foreground image generation + vision validation

  narration-audio.ts      Orchestrates TTS: draft plan -> timed plan + voiceover.wav
  narration-speech.ts     Phrase and beat timing arithmetic
                          (narration-planner.ts also exports estimateDraftNarrationTiming,
                           which fakes timings from word counts for --stills-only previews)
  subtitles.ts            SRT/VTT parsing

  render.ts               Subtitle-overlay render entry
  narrated-render.ts      Narrated-video render entry (also renders stills + silent WAV)
  publish-render.ts       Publish-cover render entry

  asset-registry.ts       Manifest + hash validation for local assets
  icon-catalog.ts         Lucide + Simple Icons resolution
  technology-catalog.ts   Brand mark resolution
  local-images.ts         External image ingestion
  image-background.ts     --background-image validation, staging, and (for PNG/JPEG)
                           the render-time palette override applied from it
  image-palette.ts        Average-color sampling + nearest-palette matching for
                           image-background.ts; WebP is skipped (see troubleshooting.md)
  visual-palettes.ts      Palette enum and colour tokens

  remotion/               React components — the actual visuals
    Root.tsx              Registers 4 compositions: AnimationClip, SubtitleClip,
                          NarratedVideo, NarratedThumbnail
    NarratedVideo.tsx     Narrated composition root
    DirectedScene.tsx     Per-scene direction and transitions
    ExplainerVisuals.tsx  The six explainer treatments
    SubtitleClip.tsx      Overlay composition
    CharacterScene.tsx    Staged 2-3 person scenes: CharacterStage (used by the
                          narrated pipeline) + CharacterScene (standalone chrome
                          for the fixture only)
    CharacterFigure.tsx   One code-drawn flat-vector person; pose arrives as props.
                          Limbs are stroked paths with round caps, so an arm has
                          a real elbow and rounded shoulder
    character-appearance.ts  Looks resolution: stated traits win, id hash fills gaps
                             (hair, skin, accessory and build)
    character-motion.ts      Mouth/blink/bob/head-turn math, arm joint + prop anchor
                             geometry, stage geometry per orientation, and
                             characterSceneTimeline (plan -> stage cues)
    character-prototype.tsx  Fixture-only compositions (3 scenarios x 2 aspects)
    text-fit.ts  timing.ts  chroma-key.ts  publish-layout.ts   pure, unit-tested

  supertonic/             Local TTS subsystem
    assets.ts             Pre-flight validation of the model directory
    client.ts             Spawns the worker as a child process
    worker.ts             ONNX inference process
    synthesis.ts          Chunking and waveform assembly
    voice-selection.ts    Automatic voice choice from plan signals
    upstream-helper.ts    Vendored from Supertone (MIT)
    protocol.ts           Zod job/response schemas for worker IPC
    wav.ts                PCM16 WAV writer

fixtures/                 Checked-in plan JSONs for tests and fixture scripts
assets/                   brands/ icons/ motion/ — local catalogs with manifests
models/supertonic-3/      TTS model (gitignored, ~822 MB, Git LFS)
```

Ignored (`.gitignore`): `node_modules/`, `.env`, `dist/`, `.remotion/`, `models/supertonic-3/`,
`samples/`.
Tests are colocated: `src/foo.ts` ↔ `src/foo.test.ts`. `tsconfig.json` excludes tests from the
build.

## Staged rendering

The pipeline can be halted and inspected at four points — script, screenshots, audio, video —
via `--plan-only`, `--stills-only`, `--audio-only`, and `--review`.

The interesting part is that **`--stills-only` needs neither the TTS model nor a provider key**.
Rendering normally requires a *timed* plan, so `estimateDraftNarrationTiming`
(`narration-planner.ts`) manufactures one: ~350 ms per word, floored at 3 s per scene, with
scene duration forced to at least `300 + beats×400 + 300` ms so beats can never overflow their
scene. `narrated-render.ts` then writes a silent WAV where the voiceover would go.

Two frames are captured per scene — 50% for the mid-animation state and 88% for the full
reveal — because a midpoint frame omits any item a later beat introduces.

See [commands.md](commands.md#staged-workflow) for the flags and output layout.

## Speech synthesis subsystem

`client.ts` **spawns `worker.ts` as a child process**, writes one JSON job to stdin, reads one
JSON response from stdout.

> ⚠️ **stdout is reserved for that single response.** The worker reassigns `console.log` to
> stderr at `worker.ts:16`. **Never write to stdout from worker code paths** — it corrupts the
> IPC channel.

The client prefers a compiled `worker.js` when present, else runs `worker.ts` via tsx
(`client.ts:15-21`). Inference is CPU-only (logs `Using CPU for inference`), roughly
real-time. Voice `auto` selection lives in `voice-selection.ts` and reports its rationale.

## Rendering subsystem

Remotion bundles `src/remotion/index.tsx` and drives headless Chrome. Four compositions are
registered in `Root.tsx`: `AnimationClip`, `SubtitleClip`, `NarratedVideo`,
`NarratedThumbnail`.

**Asset hygiene.** Saved-plan rendering never downloads a logo or animation. It validates
checked-in manifests and hashes, copies only referenced files into Remotion's temporary public
directory, and removes that staging directory afterwards. A timed plan reuses cached generated
images; if one is missing the CLI names the scene and requires an explicit
`--generated-visuals auto` rather than silently substituting unrelated art.

**Testability convention.** Pure logic lives in `text-fit.ts`, `timing.ts`, `chroma-key.ts`,
`publish-layout.ts`, `character-motion.ts`, `character-appearance.ts` and is unit-tested
without a browser. Put new rendering logic there, not in components.

**Character scenes.** `character-scene` stages 2-3 people for sources that narrate a concrete
human exchange. Two rules make it fit the existing pipeline:

- **No clock of its own.** Speaker turns, prop raises and the callout all derive from
  `primaryItemTimings` via `characterSceneTimeline`, exactly like sequence messages and chart
  points, so real TTS timings flow through unchanged.
- **Looks are derived, not authored.** The planner picks *who* is present and may state `age`;
  hairstyle, skin tone, hair colour, accessory and build come from a hash of the character id,
  so the same id looks the same in every scene and a cast never collides. Explicit traits
  always win over the hash (`character-appearance.ts`).
- **Only four fields are required.** `kind`, each `cast[].id`, each `cast[].position` and
  `sourceEvidence`. Everything else carries a `.prefault` in `explainer-visuals.ts`, because a
  model that omitted a decorative field used to lose the whole scene to a diagram downgrade.
  Grounding is the one thing never defaulted or repaired. See `docs/plan-schema.md`.

Geometry is per-orientation: 9:16 is **not** a scaled 16:9 stage, it has its own slot spacing,
figure size and callout placement (`characterStageLayout`, `character-motion.ts`).

Two placement rules are load-bearing and easy to undo by accident:

- **Figures stand on a floor, not on their heads.** `figureTopFor` positions a figure by its
  feet against `figureBaseline`. `heightScale` varies per character, so head-aligning them put
  a child's feet ~150px above an adult's. A contact shadow is drawn at `figureFootFor`.
- **A held prop is anchored to the hand**, via `propAnchorFor` over the same arm joints the
  figure draws with. A prop placed at a fixed fraction of figure size does not follow the arm,
  and floats in mid-air beside an empty hand.

**Staged backgrounds.** A scene whose visual is `character-scene` asks the image model for a
literal empty interior with a visible floor rather than an abstract metaphor, and composites it
differently: no Ken Burns drift, a lighter scrim weighted to the top instead of the bottom, and
no grid overlay (`sceneBackgroundPrompt`, `AnimatedSceneBackdrop`). The cast stands in the
lower half of the frame, which is exactly where the default treatment was darkest.

## Code conventions

- **ESM throughout** (`"type": "module"`). Relative imports need explicit `.js` extensions even
  from `.ts` sources — `module: NodeNext`.
- **Strict TS** plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. The latter
  forbids passing `{foo: undefined}` where `foo?: T` — hence the `...(x ? {x} : {})` spread
  pattern throughout the render modules.
- **Zod parses at every boundary.** Extend the schema; never hand-roll validation.

## Scale

~28,100 lines across 86 source modules and 44 test files, 523 tests, full suite ≈ 1.5 s.
