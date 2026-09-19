# Plan Schema — Data Contracts

← [AGENTS.md](../AGENTS.md) · `src/types.ts` is normative · Verified at commit `d1e65f3`

Read this before writing or editing any plan JSON or fixture.

## Two-stage lifecycle

| Stage | `stage` | Produced by | Contains |
|---|---|---|---|
| Draft | `"draft"` | Authoring, or a human | Scenes, items, phrase text. **No timings.** |
| Timed | `"timed"` | `narration-audio.ts` after synthesis | Adds `startMs`, `durationMs`, `sampleCount` per phrase |

**Timing is derived, never declared.** Phrase duration is *measured from synthesized speech*, so
a longer sentence mechanically holds its shot longer. (`--stills-only` is the one exception: it
*estimates* timings from word counts so it can preview without running TTS — see
[commands.md](commands.md#how---stills-only-avoids-the-tts-model).) `targetDurationSeconds` is a planning
hint only and is routinely overshot — a 15 s target legitimately produced 16.12 s of audio in
verification.

## Versioning — the most common trap

The current narrated-plan version is **7**, but fixtures on disk are older.
`fixtures/sample.narration-plan.json` declares `version: 4` and still loads, because
`narratedPlanSchema` (`src/types.ts:1782`) is a `z.union` of the v7 draft/timed schemas plus
legacy v5, v4, v3, v2 and v1 schemas, each carrying a `.transform(normalize…)` that upgrades in
place.

> **Consequence:** copying `sample.narration-plan.json` as a starting point works, but you are
> authoring a **v4** document. Declare `version: 7` for anything new.

## Enumerations

| Field | Values | Definition |
|---|---|---|
| `template` | `process-flow`, `comparison`, `timeline`, `callout` | `types.ts:20` |
| `palette` | `cyan`, `violet`, `emerald`, `amber`, `rose` | `visual-palettes.ts:3` |
| `expression` | `none`, `laugh`, `breath`, `sigh` | `supertonic/expressions.ts:3` |
| `aspectRatio` | `16:9`, `9:16` (`both` for selection) | `types.ts:29` |
| `voice` | `auto`, `M1`–`M5`, `F1`–`F5` | `supertonic/protocol.ts` |
| `visual.kind` | 14 treatments incl. `character-scene` | `types.ts:304` |

### `character-scene` payload

Stages 2–3 people. **Only four things are required**: `kind`, each `cast[].id`, each
`cast[].position` (`left`/`center`/`right`), and `sourceEvidence`. Everything else carries a
`.prefault` in `explainer-visuals.ts` and is filled in when omitted — `label` (`'character'`),
`outfit` (`'casual'`), `age` (`'adult'`), `behindSet` (`false`), `prop` and
`propPrimaryItemIndex` (`null`), `motion`, `motif`, `set` (`'none'`), `sign` and `callout`
(`null`). This is deliberate: a model that omitted a decorative field used to lose the whole
scene to a plain-diagram downgrade.

`speakers[]` assigns turns to primary items. A turn runs until the next one begins, so
**speakers need not cover every item** — they only have to be distinct and point at a visible
item and a declared cast id. `set` is `none` or `counter`; `sign` requires a counter, and a
counter requires at least one `behindSet` character. An optional `prop` is a semantic icon id
paired with the `propPrimaryItemIndex` that raises it. The optional `callout` carries an icon
id, eyebrow, headline, tone, the `primaryItemIndex` it resolves on, and an extractive
`sourceEvidence`.

Grounding is the one thing never repaired or defaulted: `visual.sourceEvidence` and
`callout.sourceEvidence` must each be an exact source excerpt (`explainer-visuals.ts`).
`cast[].label` is **not** checked against the source — labels are internal and never drawn, and
demanding them verbatim rejected a correct scene that wrote "Customer" where the source said
"an individual". Bookkeeping failures (duplicate ids or positions, an out-of-range prop cue or
callout index, a speaker naming an absent character, an icon id outside the catalogue, a
counter with nobody behind it) are repaired in `narration-plan-recovery.ts` rather than
rejected.

## Cardinality and length limits

| Constraint | Limit |
|---|---|
| Scenes per plan | 1 – 6 |
| Beats per scene | 1 – 12 |
| `primaryItems` / `secondaryItems` | 1 – 6 / 0 – 6 |
| Plan `title` | ≤ 100 chars |
| Scene `title` | ≤ 80 chars |
| Item labels | ≤ 80 chars |
| Phrase `text` | **≤ 120 chars** |
| `reason` | ≤ 180 chars |
| `backgroundPrompt` | ≤ 600 chars |
| `leftLabel` / `rightLabel` | ≤ 40 chars |
| `sourceEvidence` (any treatment) | ≤ 600 chars |
| `cast[]` | 2 – 3 |
| `cast[].id` | `^[a-z0-9-]+$` |
| `cast[].label` | ≤ 32 chars |
| `speakers[]` | 1 – 6 |
| `sign` | ≤ 16 chars |
| `callout.eyebrow` / `callout.headline` | ≤ 28 / ≤ 48 chars |

## Cross-field rules

- `template: "comparison"` **fails validation** when `secondaryItems` is empty
  (`types.ts:946`).
- A beat's `primaryItemIndices` are **zero-based indices into the scene's `primaryItems`**,
  selecting which labels are lit while that beat is spoken.
- **Every primary item must be anchored exactly once, in visual order.** Each index must appear
  in exactly one beat, and the beats must introduce them in ascending order. Skipping an item,
  anchoring one twice, or anchoring out of order all fail validation. This is the constraint
  hand-written plans trip over most often.
- Phrase `text` must not contain `<laugh>`, `<breath>` or `<sigh>` — expressions belong in the
  beat's `expression` field.
- Research-enriched plans must carry **both** `originalSourceText` and `research`, or neither
  (`types.ts:1184`).

## Field-by-field: what controls what on screen

Using a minimal one-scene plan:

| Field | Controls |
|---|---|
| `title` | Opening title card |
| `palette` | Colour scheme for the whole video — overridden at render time when `--background-image` supplies a PNG/JPEG with a clear dominant hue (`image-background.ts:applyImageBackgroundPalette`, color sampling in `image-palette.ts`); the saved plan JSON itself is never rewritten |
| `scenes[].template` | Layout family — `process-flow` draws connected left-to-right nodes |
| `scenes[].title` | Scene heading |
| `scenes[].primaryItems` | The labels drawn on screen (one node each) |
| `beats[].phrases[].text` | **The spoken line — and therefore the shot's duration** |
| `beats[].primaryItemIndices` | Which item(s) are lit while that beat is spoken |
| `beats[].expression` | Injects `<breath>` / `<laugh>` / `<sigh>` before the beat's audio |
| `targetDurationSeconds` | Planning hint only; actual length comes from speech |
| `backgroundPrompt` | **Ignored** unless `--scene-background generated` (billed) |
| `reason` | Planner metadata; never rendered |

Pointing successive beats at `[0]`, `[1]`, `[2]` advances one node per sentence. Pointing two
beats at the same index holds a node. `[0,1]` lights two at once.

## Mandatory validation step

Always validate before rendering — seconds versus minutes:

```bash
pnpm run animations create --render-plan <plan.json> --plan-only
```

Success prints: `Draft narrated plan is valid; --plan-only skipped synthesis.`

## Worked example

A validated ~16 s, one-scene, three-beat plan:

```json
{
  "version": 7,
  "kind": "narrated-video",
  "stage": "draft",
  "sourceText": "...",
  "generatedAt": "2026-09-16T00:00:00.000Z",
  "model": "offline-fixture",
  "targetDurationSeconds": 15,
  "language": "en",
  "title": "How this repo renders a video",
  "palette": "violet",
  "mediaAssets": [],
  "scenes": [{
    "id": "render-pipeline",
    "backgroundPrompt": "An abstract pipeline carrying a document into a video frame.",
    "template": "process-flow",
    "title": "From plan file to finished MP4",
    "primaryItems": ["Plan JSON", "Remotion + Chrome", "Narrated MP4"],
    "secondaryItems": [], "leftLabel": "", "rightLabel": "",
    "reason": "Shows the three stages of the offline render pipeline.",
    "beats": [
      { "id": "b1", "expression": "breath",
        "phrases": [{"id": "b1-1", "text": "A hand-written plan file describes every scene"},
                    {"id": "b1-2", "text": "and every spoken line."}],
        "primaryItemIndices": [0], "secondaryItemIndices": [] },
      { "id": "b2", "expression": "none",
        "phrases": [{"id": "b2-1", "text": "Remotion draws the frames in headless Chrome"},
                    {"id": "b2-2", "text": "while a local voice model speaks the script."}],
        "primaryItemIndices": [1], "secondaryItemIndices": [] },
      { "id": "b3", "expression": "none",
        "phrases": [{"id": "b3-1", "text": "No API key, no network call,"},
                    {"id": "b3-2", "text": "just a finished video."}],
        "primaryItemIndices": [2], "secondaryItemIndices": [] }
    ]
  }]
}
```

Note: a v4 plan omits `mediaAssets` and uses a simpler `visual` shape; the union upgrades it.
