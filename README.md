# @superjeason/pi-model-manager

Three pi commands for managing custom model providers in `~/.pi/agent/models.json`, with models.dev-first metadata enrichment.

## Commands

### `/add-provider` — interactive wizard

Adds a new OpenAI-compatible provider end-to-end:

1. Enter **provider name**, **base URL**, **API key**
2. Choose **API type** (all built-in pi formats)
3. Fetches `{baseUrl}/models` (standard OpenAI format) with a cancellable loader
4. Multi-select models (**Space** toggle, **Enter** confirm, **Esc** cancel)
   - If `/models` fetch fails, type model ids manually (comma-separated)
5. Optionally enrich config from models.dev first, then the built-in pi-ai library (same logic as `/sync-model`)
6. Writes the provider to `models.json`

Then `/reload` and the new provider appears in `/model`.

### `/edit-provider` — modify an existing provider

Select a provider (shown with model count and baseUrl), then choose an action:

- **Change API format** — pick from built-in API types
- **Manage models**
  - Add from `/models` endpoint, or type ids manually
  - Remove existing models (multi-select + confirm)
  - Adding can enrich from models.dev first, then the built-in library
- **Edit connection** — change `baseUrl` / `apiKey`  
  (current value in the prompt; empty keeps, `-` removes, Esc cancels)
- **Enrich model config**
  - Safe: fill **missing** fields only
  - Overwrite: clear matched fields then re-fill (`reasoning` is preserved)
- **Delete provider** — remove provider and all models (confirm)

All destructive ops ask for confirmation first.

### `/sync-model` — fill missing model config

Reads `models.json`, matches each custom model **by id** against models.dev first, then built-in models loaded at runtime, and fills fields you didn't set:

- `thinkingLevelMap` (from models.dev `reasoning_options` when available; enables `max` / `xhigh` thinking levels)
- `cost` (from models.dev `api.json` pricing → pi `{input,output,cacheRead,cacheWrite[,tiers]}` USD/1M; fills missing or all-zero placeholders)
- `compat` (from built-in pi metadata; merged, your values win)
- `maxTokens`, `contextWindow`, `reasoning`, `input`, `name`

Only fills **missing** fields — anything set explicitly is preserved. Idempotent.

Matching prefers **canonical families** over reseller/gateway clones:

| bare id example | preferred family |
|---|---|
| `gpt-5.5` / `o3` | `openai` |
| `claude-*` | `anthropic` |
| `gemini-*` | `google` |
| `grok-*` | `xai` |
| `glm-*` | `zhipuai` / `zai` |
| `qwen*` / `qwq*` / `qvq*` | `alibaba` / `qwen` / `dashscope` |
| `doubao*` / `seed-1.*` | `volcengine` / `bytedance` |
| `mimo-*` / `xiaomi-mimo*` | `xiaomi` |
| `minimax*` / `abab*` | `minimax` |
| `kimi*` / `moonshot*` | `moonshotai` |

You can also set an explicit family on the provider or model:

```json
{
  "providers": {
    "cpa": {
      "modelFamily": "openai",
      "models": [
        { "id": "gpt-5.5", "modelFamily": "openai" }
      ]
    }
  }
}
```

```
/sync-model              # fill missing fields, write back
/sync-model preview      # show what would change without writing
/sync-model force        # clear enrichable fields, then re-match (rewrites maps)
/sync-model force preview
```

Tab completion is available for `preview` / `dry-run` / `force`.
Use `force` when an older sparse/wrong `thinkingLevelMap` is stuck (safe mode never overwrites existing fields).

## Why

Custom providers don't inherit authoritative model metadata. models.dev exposes model limits (`context`, `output`), modalities, `reasoning`, and provider-level `reasoning_options`; pi's built-in registry can also provide `compat` details. Without `thinkingLevelMap`, the `max` / `xhigh` thinking levels may be unavailable or clamped. These commands fill that in by matching model ids.

## Install

```bash
pi install git:github.com/superjeason/pi-model-manager
# or
pi install npm:@superjeason/pi-model-manager
# or local path
pi install ./pi-model-manager
```

Then `/reload`.

## Multi-select controls

| Key | Action |
|-----|--------|
| Space | Toggle current item |
| ↑ / ↓ | Move cursor |
| PageUp / PageDown | Page |
| Home / End | First / last |
| Enter | Confirm selection |
| Esc / Ctrl+C | Cancel (uses pi's `tui.select.cancel` plus low-level `matchesKey("escape")`; returns without changes) |
| type | Filter list (Unicode supported) |
| Backspace | Clear filter char |
| Ctrl+A | Select all **visible** (uses low-level `matchesKey("ctrl+a")`) |
| Ctrl+D | Deselect all (uses low-level `matchesKey("ctrl+d")`) |

Selection is tracked by model id, so filtering does not scramble checks.
In non-TUI modes (RPC/print), falls back to one-by-one Add/Skip prompts.
**Cancel is never treated as "fall back to one-by-one".**

## Requirements & Notes

- `/add-provider` prefers a standard OpenAI-compatible `/models` endpoint  
  (`GET {baseUrl}/models` → `{"data":[{"id":"..."}]}`).  
  `baseUrl` with or without trailing `/v1` both work.  
  If the endpoint is missing (e.g. anthropic-messages / google-generative-ai), type ids manually.
- Supports all built-in pi API formats: `openai-completions`, `openai-responses`,
  `anthropic-messages`, `google-generative-ai`, `google-vertex`,
  `mistral-conversations`, `openai-codex-responses`, `azure-openai-responses`,
  `bedrock-converse-stream`.
- `models.json` must be pure JSON (no `//` comments).
- Overwriting an existing provider prompts for confirmation; other providers untouched.
- Enrich only adds missing fields; manual edits are never clobbered (unless you choose overwrite / `/sync-model force`).
- Metadata source order: models.dev `models.json` + `api.json` first (canonical family preferred), then pi built-in registry.
- Bare ids like `gpt-5.5` prefer `openai/gpt-5.5` over reseller copies (`vivgrid`, `302ai`, …).
- Optional `modelFamily` on provider or model overrides family inference.
- `cost` is filled when missing or all zeros (common custom-provider placeholders); non-zero user costs are kept.
- models.dev `models.json` has limits/modalities; pricing usually comes from `api.json` and is merged in.
- models.dev responses are cached under `~/.cache/pi-model-manager/` for 7 days; stale cache is used if refresh fails.
- Uses pi theme tokens for multi-select colors and focus state (`selectedBg`, `accent`, `success`, `dim`, `muted`, `warning`).
- Focused rows use a full-width `selectedBg` band plus an accent bar (`▌`); checked rows use `[x]` without stealing focus.
- Runtime deps: Node built-ins only; peer: `@earendil-works/pi-coding-agent` (provides `pi-tui`).

## Structure

```
pi-model-manager/
├── index.ts         # /add-provider + /edit-provider + /sync-model
├── enrich.ts        # shared model-matching & config-filling
├── multi-select.ts  # themed multi-select TUI component
├── package.json
└── README.md
```
