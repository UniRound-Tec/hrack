---
name: create-hrack-floating-renderer
description: Create, modify, debug, or package HRack floating-window renderers, including HTML/CSS widgets, animated desktop mascots, irregular transparent windows, and Live2D companions. Use when implementing a built-in or user-installed floating renderer, connecting visuals to real CLI turn/session state, adding renderer controls or resize behavior, or adapting licensed character assets for HRack's sandbox.
---

# Create an HRack Floating Renderer

Produce a local, offline renderer driven by HRack's authoritative session snapshots. Preserve the sandbox and treat built-in and user renderers as implementations of the same contract.

## Start from the repository

1. Read `docs/FLOATING-RENDERERS.md` and `shared/floating-window.ts` completely. Current source wins if this Skill is stale.
2. Inspect `examples/floating-renderers/` for reusable HTML renderers and `resources/floating-renderers/live2d-mao/` for the built-in Live2D pattern.
3. Decide the delivery target:
   - Put user implementations in the directory opened by **Settings → Layout → Floating renderer → Open folder**.
   - Put product-owned implementations in `resources/floating-renderers/<id>/` and register them as `builtin/<id>` in `FloatingRendererRegistry`.
4. Do not edit user preferences or silently select/enable a renderer unless the user explicitly authorizes it.
5. If the public contract changes, update the shared types, preload validation, IPC boundary, docs, this Skill, and targeted tests together.

## Renderer package

Create one self-contained directory:

```text
my-renderer/
├─ manifest.json
├─ index.html
├─ style.css
├─ app.js
└─ assets/
```

Use schema version 1:

```json
{
  "schemaVersion": 1,
  "id": "my-renderer",
  "name": "My Renderer",
  "version": "0.1.0",
  "entry": "index.html",
  "width": 320,
  "minHeight": 180,
  "maxHeight": 600
}
```

Keep `id` lowercase with letters, digits, dots, underscores, or hyphens. Keep all paths relative and every individual asset below 16 MiB.

## Use only the renderer bridge

The page receives only `window.hrackFloating`:

```ts
interface FloatingRendererApi {
  getSnapshot(): Promise<FloatingRendererSnapshot>
  onSnapshot(callback: (snapshot: FloatingRendererSnapshot) => void): () => void
  resizeToContent(height: number): Promise<void>
  setShape(rects: Array<{ x: number; y: number; width: number; height: number }>): Promise<void>
  focusSession(sessionId: string): Promise<boolean>
  disable(): Promise<void>
}
```

Subscribe before the initial read so no update is lost:

```js
const unsubscribe = window.hrackFloating.onSnapshot(render)
window.hrackFloating.getSnapshot().then(render)
window.addEventListener('pagehide', unsubscribe, { once: true })
```

Never access Node.js, `require`, PTY APIs, workspace APIs, Electron IPC, the network, or another renderer's directory. Do not weaken `contextIsolation`, `sandbox`, CSP, navigation blocking, or permission denial to make an implementation work.

## Render authoritative state

Treat every callback as a full replacement snapshot. Do not merge it into an independent session state machine.

Select the current session from the already activity-sorted `snapshot.sessions`; use the first item unless the design explicitly renders several sessions. Read:

```ts
interface FloatingSession {
  sessionId: string
  adapterId: string
  name?: string
  status: 'working' | 'needs-you' | 'done' | 'error' | 'idle' | 'exited'
  statusConfidence: 'high' | 'low'
  observerHealth: 'unconfirmed' | 'healthy' | 'stale' | 'lifecycle-only'
  detail?: string
  pendingAttentionCount: number
  lastActivityAt: number
  lastSeq: number
  activeTurnId?: string
  activeToolCount: number
  lastTurnOutcome?: 'completed' | 'cancelled' | 'failed'
}
```

Use the real turn fields directly:

- `activeTurnId`: identity of the currently running turn.
- `activeToolCount`: concurrent tools currently running.
- `lastTurnOutcome`: terminal outcome of the latest turn.
- `lastSeq`: latest authoritative projection sequence; ignore locally cached older work.
- `attention.sequence`: one-shot transition signal for `needs-you`, `done`, or `error`.

Always show canonical status even when `attentionEffectEnabled` is false. Only suppress attention animation/sound-like visual emphasis. Never replay an old attention sequence after effects are re-enabled.

Recommended visual mapping:

| State | Persistent pose | One-shot transition |
| --- | --- | --- |
| `idle` | calm idle loop | settle |
| `working` | focused motion | start/continue gesture |
| `needs-you` | attentive pose | prominent pulse or wave |
| `done` | relaxed/happy pose | completion pop |
| `error` | concerned pose | short shake |

Restart a one-shot animation only when `status`, `lastSeq`, or `attention.sequence` advances. Use CSS/Web Animations or the animation runtime's public API; do not synthesize pointer events against a Canvas/WebGL model.

## Size and coordinates

Author layout in the manifest's unscaled CSS pixels. HRack applies the user's 60%–160% scale uniformly to the native window, web-content zoom, and native shape.

- Call `resizeToContent()` with intrinsic, unscaled content height.
- Pass unscaled CSS-pixel rectangles to `setShape()`.
- Do not apply another user-scale transform in the renderer.
- Handle viewport resize and device pixel ratio for Canvas/WebGL sharpness.
- Keep content inside the manifest width and height bounds.

## Live2D implementation

Bundle the licensed Cubism runtime and model assets locally. Use relative same-origin URLs; CDN and remote fetches are blocked.

Include the required `.model3.json`, `.moc3`, textures, expressions, motions, physics, poses, shaders/WASM, and notices. Keep the Cubism Framework/Samples release compatible with Cubism Core; the built-in Mao reference uses Web Samples/Framework `5-r.4` with Core `05.01.0000`.

Follow this lifecycle:

1. Initialize WebGL and load Core before the framework bundle.
2. Wait for a model-ready signal before invoking motion or expression APIs.
3. Keep the model's native idle motion running.
4. Map HRack state transitions to named motions/expressions through public runtime APIs. If the bundled runtime does not expose stable controls, animate the Canvas element with Web Animations instead.
5. Pause or reduce work while `document.hidden` and honor `prefers-reduced-motion`.
6. Release animation handles, listeners, textures, and WebGL resources on unload.

Do not mix incompatible Core and Framework versions. Do not redistribute a model, Core, or SDK merely because it is publicly downloadable. Preserve source, copyright, Free Material, Open Software, Proprietary Software, and release-license notices; report any unresolved publication requirement.

## Irregular transparent windows

Call `setShape()` with no more than 1024 rectangles. Derive them from stable alpha silhouettes or use a conservative motion envelope. Include space for hair, limbs, shadows, gestures, and attention bursts.

Windows and Linux clip both pixels and pointer hit-testing outside the shape. macOS keeps transparent visual fallback behavior. Do not recompute or submit the shape on every animation frame.

## Interaction and accessibility

- Provide an obvious drag region with `-webkit-app-region: drag`.
- Mark buttons and other controls `-webkit-app-region: no-drag`.
- Keep controls keyboard accessible and labelled.
- Use `focusSession(sessionId)` to return to the real HRack session.
- Use `disable()` only for an explicit close action.
- Apply `snapshot.appearance` when the design should follow HRack's current theme.

## Validate and deliver

1. Validate manifest paths and JavaScript syntax.
2. Type-check HRack after changing TypeScript or the public bridge.
3. Build HRack when registering or packaging a built-in renderer.
4. Run targeted `e2e/floating-window.spec.ts` cases first. After a failure, rerun only the failed case until fixed; do not repeatedly run the full E2E suite.
5. Verify empty, working, needs-you, done, error, effect-disabled, and scale states.
6. For Live2D, verify Core exists, WebGL initializes, local `.moc3` loads, frames visibly change, and `pageErrors()` stays empty.
7. Verify a remote fetch is blocked and an invalid user renderer falls back to `builtin/default`.
8. Launch the real development app after the checks and tell the user where to select the renderer.

Report changed files, targeted checks, any skipped full regression, the renderer directory/ID, and all model/runtime licensing obligations.
