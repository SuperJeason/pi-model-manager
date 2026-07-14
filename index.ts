/**
 * @superjeason/pi-model-manager
 *
 * Commands share one "match models.dev / built-in model by id and fill missing fields" path:
 *
 *   /add-provider  Interactive OpenAI-compatible provider wizard
 *   /edit-provider Edit existing provider (models, connection, enrich, delete)
 *   /sync-model    Fill missing fields on custom models from models.dev, then built-in library
 *
 * Only missing fields are filled; existing values are preserved. Idempotent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createEnrichContext,
  enrichModel,
  type EnrichContext,
  type EnrichSource,
  type LikeModel,
  type ModelsJsonConfig,
} from "./enrich.js";
import { MultiSelect, type MultiSelectItem, type MultiSelectTheme } from "./multi-select.js";

const MODELS_JSON = () => join(homedir(), ".pi", "agent", "models.json");

/**
 * Multi-select dialog (TUI).
 * Returns:
 *   string[] — confirmed selection (may be empty)
 *   null     — cancelled (Esc / Ctrl+C) OR TUI unavailable / error
 * Callers must not treat null as "fall back to one-by-one".
 */
async function multiSelectItems(
  ctx: { mode: string; ui: any },
  title: string,
  items: MultiSelectItem[],
): Promise<string[] | null> {
  if (ctx.mode !== "tui") return null;
  if (items.length === 0) return [];
  try {
    return await ctx.ui.custom<string[] | null>((tui: any, theme: any, keybindings: any, done: (v: string[] | null) => void) => {
      const th: MultiSelectTheme = {
        title: (s) => theme.fg("accent", theme.bold(s)),
        accent: (s) => theme.fg("accent", s),
        success: (s) => theme.fg("success", s),
        dim: (s) => theme.fg("dim", s),
        muted: (s) => theme.fg("muted", s),
        warning: (s) => theme.fg("warning", s),
        bold: (s) => theme.bold(s),
        // Full-row highlight — same token pi uses for selectors
        row: (s) => theme.bg("selectedBg", s),
        rowText: (s) => theme.fg("text", s),
      };

      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      const ms = new MultiSelect({
        items,
        title,
        maxVisible: Math.min(20, Math.max(8, items.length)),
        theme: th,
        keybindings,
        onDirty: () => tui.requestRender(),
        done: (val) => done(val),
      });
      container.addChild(ms);
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          ms.handleInput(data);
          tui.requestRender();
        },
      };
    });
  } catch {
    return null;
  }
}

/** One-by-one yes/no fallback for non-TUI modes. Returns null if cancelled mid-way. */
async function selectOneByOne(
  ui: any,
  ids: string[],
  yesLabel: string,
  noLabel: string,
  promptFor: (id: string) => string,
): Promise<string[] | null> {
  const out: string[] = [];
  for (const id of ids) {
    const choice = await ui.select(promptFor(id), [yesLabel, noLabel], {});
    if (choice === undefined) return null; // cancelled
    if (choice === yesLabel) out.push(id);
  }
  return out;
}

/**
 * Pick models: prefer multi-select TUI; only fall back to one-by-one when
 * multi-select is unavailable (non-TUI / component error), never on user cancel.
 */
async function pickModels(
  ctx: { mode: string; ui: any },
  title: string,
  ids: string[],
  mode: "add" | "delete",
): Promise<string[] | null> {
  const items: MultiSelectItem[] = ids.map((id) => ({ value: id, label: id }));
  // Try multi-select only in TUI; null means unavailable OR cancelled.
  // Distinguish by: if TUI and custom works, cancel returns null from done().
  // If non-TUI, multiSelectItems returns null immediately → fall back.
  if (ctx.mode === "tui") {
    const result = await multiSelectItems(ctx, title, items);
    // multiSelectItems only returns null on cancel or hard failure.
    // Empty array is a valid "confirmed nothing".
    // On hard failure (catch), also null — fall back below only if we detect
    // that custom UI never ran. We treat null as cancel in TUI (user intent).
    return result;
  }
  // Non-TUI fallback
  if (mode === "add") {
    return selectOneByOne(
      ctx.ui,
      ids,
      "Add",
      "Skip",
      (id) => `Add model?  [${id}]`,
    );
  }
  return selectOneByOne(
    ctx.ui,
    ids,
    "Delete",
    "Keep",
    (id) => `Delete model?  [${id}]`,
  );
}

/** Fetch /models with a cancellable bordered loader in TUI; plain fetch otherwise. */
async function fetchModelsWithUI(
  ctx: { mode: string; ui: any },
  baseUrl: string,
  apiKey: string,
): Promise<{ models: RemoteModel[]; error?: string; cancelled?: boolean }> {
  if (ctx.mode === "tui") {
    try {
      return await ctx.ui.custom<{ models: RemoteModel[]; error?: string; cancelled?: boolean }>(
        (tui: any, theme: any, _kb: any, done: (v: any) => void) => {
          const loader = new BorderedLoader(tui, theme, "Fetching model list…");
          loader.onAbort = () => done({ models: [], cancelled: true });
          fetchModels(baseUrl, apiKey, loader.signal)
            .then((models) => done({ models }))
            .catch((e: Error) => {
              if (e.name === "AbortError") done({ models: [], cancelled: true });
              else done({ models: [], error: e.message });
            });
          return loader;
        },
      );
    } catch (e) {
      return { models: [], error: (e as Error).message };
    }
  }
  try {
    const models = await fetchModels(baseUrl, apiKey);
    return { models };
  } catch (e) {
    return { models: [], error: (e as Error).message };
  }
}

/** API formats supported by pi (aligned with BUILTIN_APIS). */
const API_CHOICES: { id: string; label: string }[] = [
  { id: "openai-completions", label: "openai-completions — Chat Completions (most proxies / local servers, recommended)" },
  { id: "openai-responses", label: "openai-responses — Responses API (native OpenAI)" },
  { id: "anthropic-messages", label: "anthropic-messages — Anthropic Messages API" },
  { id: "google-generative-ai", label: "google-generative-ai — Google Generative AI" },
  { id: "google-vertex", label: "google-vertex — Vertex AI" },
  { id: "mistral-conversations", label: "mistral-conversations — Mistral Conversations API" },
  { id: "openai-codex-responses", label: "openai-codex-responses — Codex Responses (subscription)" },
  { id: "azure-openai-responses", label: "azure-openai-responses — Azure OpenAI Responses" },
  { id: "bedrock-converse-stream", label: "bedrock-converse-stream — AWS Bedrock Converse" },
];

function loadConfig(path: string): ModelsJsonConfig {
  if (!existsSync(path)) return { providers: {} };
  return JSON.parse(readFileSync(path, "utf-8")) as ModelsJsonConfig;
}

function saveConfig(path: string, config: ModelsJsonConfig): void {
  writeFileSync(path, JSON.stringify(config, null, 4) + "\n", "utf-8");
}

function apiIdFromLabel(label: string): string {
  return label.split(" —")[0].trim();
}

function sourceLabel(src: EnrichSource): string {
  return src.sourceLabel ?? src.provider ?? "metadata";
}

function sourceRef(src: EnrichSource): string {
  return `${sourceLabel(src)}/${src.id}`;
}

/** Enrich every model under a provider; return report lines + counters. */
function enrichProvider(
  provName: string,
  provCfg: ModelsJsonConfig["providers"][string],
  enrichCtx: EnrichContext,
): { report: string[]; changed: number; matched: number; noMatch: number } {
  const report: string[] = [];
  let changed = 0, matched = 0, noMatch = 0;
  const models = provCfg.models;
  if (!Array.isArray(models)) return { report, changed, matched, noMatch };
  for (const m of models) {
    const [patches, src] = enrichModel(m, enrichCtx);
    if (!src) {
      noMatch++;
      report.push(`· ${provName}/${m.id} — no models.dev or built-in match, skipped`);
      continue;
    }
    matched++;
    if (patches.length > 0) {
      changed++;
      report.push(`✓ ${provName}/${m.id} ← ${sourceRef(src)}  +${patches.join(",")}`);
    } else {
      report.push(`= ${provName}/${m.id} ← ${sourceRef(src)}  already complete`);
    }
  }
  return { report, changed, matched, noMatch };
}

// ---------------- /models endpoint ----------------
interface RemoteModel { id: string }

async function fetchModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<RemoteModel[]> {
  let url = baseUrl.replace(/\/+$/, "");
  if (!/\/v\d+$/i.test(url)) url += "/v1";
  url += "/models";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  const json = (await res.json()) as { data?: RemoteModel[] };
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.filter((m) => m && typeof m.id === "string" && m.id.trim() && !/^all\b/i.test(m.id.trim()));
}

function formatReloadHint(): string {
  return "Run /reload, then pick the provider in /model.";
}

export default function (pi: ExtensionAPI) {
  // ===================== /add-provider =====================
  pi.registerCommand("add-provider", {
    description: "Interactively add an OpenAI-compatible provider (fetch models + optional enrich)",
    handler: async (_args: string, ctx) => {
      const path = MODELS_JSON();
      const ui = ctx.ui;

      // 1. Basic provider info
      const name = (await ui.input("Provider name (e.g. didi, my-proxy):"))?.trim();
      if (!name) { ui.notify("Cancelled.", "info"); return; }
      if (!/^[a-z0-9][a-z0-9-_.]*$/i.test(name)) {
        ui.notify(`Invalid name "${name}": must start with a letter/digit and contain only letters, digits, -, _, .`, "error");
        return;
      }
      const baseUrl = (await ui.input("Base URL (e.g. https://xxx.com/v1):"))?.trim();
      if (!baseUrl) { ui.notify("Cancelled.", "info"); return; }
      const apiKey = (await ui.input("API key (leave empty to omit; use /login or --api-key later):"))?.trim() ?? "";

      const apiChoice = await ui.select(
        "API type (request/response format):",
        API_CHOICES.map((a) => a.label),
        {},
      );
      if (!apiChoice) { ui.notify("Cancelled.", "info"); return; }
      const apiType = apiIdFromLabel(apiChoice);

      // 2. Load config + name clash
      let config: ModelsJsonConfig;
      try { config = loadConfig(path); }
      catch (e) { ui.notify(`Failed to parse models.json: ${(e as Error).message}`, "error"); return; }
      if (config.providers[name]) {
        const overwrite = await ui.confirm(
          `Provider "${name}" already exists`,
          `Overwrite providers.${name}? Other providers are left untouched.`,
        );
        if (!overwrite) { ui.notify("Cancelled.", "info"); return; }
      }

      // 3. Fetch model list
      const fetched = await fetchModelsWithUI(ctx, baseUrl, apiKey);
      if (fetched.cancelled) { ui.notify("Cancelled.", "info"); return; }

      let modelIds = fetched.models.map((m) => m.id);
      let fetchError = fetched.error ?? (modelIds.length === 0 ? "endpoint returned an empty list" : "");

      // 4. Select models
      let selected: string[] = [];
      if (modelIds.length > 0) {
        const picked = await pickModels(ctx, `Add models · ${name}`, modelIds, "add");
        if (picked === null) { ui.notify("Cancelled.", "info"); return; }
        selected = picked;
        if (selected.length === 0) { ui.notify("No models selected. Cancelled.", "warning"); return; }
      } else {
        const manual = await ui.input(
          `Fetch failed (${fetchError}). Enter model ids, comma-separated (e.g. glm-5.2,glm-4.7):`,
        );
        if (!manual?.trim()) { ui.notify("No models provided. Cancelled.", "info"); return; }
        selected = manual.split(",").map((s) => s.trim()).filter(Boolean);
        if (selected.length === 0) { ui.notify("No models provided. Cancelled.", "info"); return; }
      }

      // 5. Optional enrich
      const doEnrich = await ui.confirm(
        "Enrich model config?",
        "Use models.dev when available, then fall back to the built-in library. Fills thinkingLevelMap / contextWindow / maxTokens / input. Existing fields are never overwritten.",
      );

      // 6. Build provider config
      const providerCfg: ModelsJsonConfig["providers"][string] = {
        baseUrl,
        api: apiType,
        models: selected.map((id) => ({ id })),
      };
      if (apiKey) providerCfg.apiKey = apiKey;

      // 7. Enrich
      const report: string[] = [];
      if (doEnrich) {
        const customNames = new Set(Object.keys(config.providers));
        customNames.add(name);
        const enrichCtx = await createEnrichContext(ctx, customNames);
        let enriched = 0;
        for (const m of providerCfg.models!) {
          const [patches, src] = enrichModel(m, enrichCtx);
          if (src && patches.length > 0) {
            enriched++;
            report.push(`✓ ${m.id} ← ${sourceRef(src)}  +${patches.join(",")}`);
          } else if (src) {
            report.push(`= ${m.id} ← ${sourceRef(src)}  already complete`);
          } else {
            report.push(`· ${m.id} — no models.dev or built-in match, id only`);
          }
        }
        report.unshift(`Enriched ${enriched}/${selected.length} models (models.dev first)`);
      }

      // 8. Write
      config.providers[name] = providerCfg;
      try { saveConfig(path, config); }
      catch (e) { ui.notify(`Failed to write models.json: ${(e as Error).message}`, "error"); return; }

      const head = [
        `Added provider ${name}`,
        `  baseUrl  ${baseUrl}`,
        `  api      ${apiType}${apiKey ? "  ·  apiKey set" : "  ·  no apiKey"}`,
        `  models   ${selected.join(", ")}`,
        "",
        ...report,
        "",
        formatReloadHint(),
      ].join("\n");
      ui.notify(head, "info");
    },
  });

  // ===================== /sync-model =====================
  pi.registerCommand("sync-model", {
    description: "Use models.dev first, then built-in models, to fill missing thinkingLevelMap / context / maxTokens, etc.",
    handler: async (args: string, ctx) => {
      const path = MODELS_JSON();
      const ui = ctx.ui;
      if (!existsSync(path)) { ui.notify("models.json not found: " + path, "error"); return; }

      const dryRun = /\b(preview|dry-run|dryrun)\b/i.test(args ?? "");
      let config: ModelsJsonConfig;
      try { config = loadConfig(path); }
      catch (e) {
        ui.notify(
          `Failed to parse models.json: ${(e as Error).message}\n(Remove // comments first; pure JSON only.)`,
          "error",
        );
        return;
      }

      const customNames = new Set(Object.keys(config.providers));
      const enrichCtx = await createEnrichContext(ctx, customNames);

      const all: ReturnType<typeof enrichProvider>[] = [];
      let changed = 0, matched = 0, noMatch = 0;
      for (const [provName, provCfg] of Object.entries(config.providers)) {
        const r = enrichProvider(provName, provCfg, enrichCtx);
        all.push(r);
        changed += r.changed; matched += r.matched; noMatch += r.noMatch;
      }

      if (changed > 0 && !dryRun) saveConfig(path, config);

      const report = all.flatMap((r) => r.report);
      const head =
        `${dryRun ? "[preview · not written] " : ""}/sync-model: matched ${matched} · enriched ${changed} · no match ${noMatch} · source models.dev→built-in` +
        (changed > 0 && !dryRun ? `\nWrote models.json. ${formatReloadHint()}` : "");
      ui.notify([head, "", ...report].join("\n"), changed > 0 || dryRun ? "info" : "warning");
    },
  });

  // ===================== /edit-provider =====================
  pi.registerCommand("edit-provider", {
    description: "Edit a provider: models, connection, API format, enrich, or delete",
    handler: async (_args: string, ctx) => {
      const path = MODELS_JSON();
      const ui = ctx.ui;
      if (!existsSync(path)) { ui.notify("models.json not found: " + path, "error"); return; }

      let config: ModelsJsonConfig;
      try { config = loadConfig(path); }
      catch (e) { ui.notify(`Failed to parse models.json: ${(e as Error).message}`, "error"); return; }

      const provNames = Object.keys(config.providers);
      if (provNames.length === 0) {
        ui.notify("No providers in models.json. Use /add-provider first.", "warning");
        return;
      }

      // Show name + model count for faster scanning
      const provLabels = provNames.map((n) => {
        const count = config.providers[n]?.models?.length ?? 0;
        const url = config.providers[n]?.baseUrl ?? "";
        return url ? `${n}  ·  ${count} models  ·  ${url}` : `${n}  ·  ${count} models`;
      });
      const pickedLabel = await ui.select("Select a provider to edit:", provLabels, {});
      if (!pickedLabel) { ui.notify("Cancelled.", "info"); return; }
      const provName = pickedLabel.split("  ·  ")[0].trim();
      const provCfg = config.providers[provName];
      if (!provCfg) { ui.notify(`Provider "${provName}" not found.`, "error"); return; }

      const ACTIONS = {
        api: "Change API format",
        models: "Manage models",
        conn: "Edit connection (baseUrl / apiKey)",
        enrich: "Enrich model config",
        del: "Delete provider",
        cancel: "Cancel",
      } as const;

      const action = await ui.select(
        `Edit ${provName} · choose an action:`,
        [ACTIONS.api, ACTIONS.models, ACTIONS.conn, ACTIONS.enrich, ACTIONS.del, ACTIONS.cancel],
        {},
      );
      if (!action || action === ACTIONS.cancel) { ui.notify("Cancelled.", "info"); return; }

      let dirty = false;
      const report: string[] = [];

      // ---------- Change API format ----------
      if (action === ACTIONS.api) {
        const current = typeof provCfg.api === "string" ? provCfg.api : "";
        const curLabel = API_CHOICES.find((a) => a.id === current)?.label ?? current ?? "(empty)";
        const picked = await ui.select(
          `New API format (current: ${curLabel}):`,
          [...API_CHOICES.map((a) => a.label), "(remove field)"],
          {},
        );
        if (!picked) { ui.notify("Cancelled.", "info"); return; }
        const trimmed = picked === "(remove field)" ? "" : apiIdFromLabel(picked);
        if (trimmed === current) { ui.notify("No change.", "info"); return; }
        const ok = await ui.confirm(
          `Change ${provName}.api?`,
          `Old: ${current || "(empty)"}\nNew: ${trimmed || "(empty)"}`,
        );
        if (!ok) { ui.notify("Cancelled.", "info"); return; }
        if (trimmed === "") delete provCfg.api;
        else provCfg.api = trimmed;
        dirty = true;
        report.push(`✓ api: ${current || "(empty)"} → ${trimmed || "(removed)"}`);
      }

      // ---------- Manage models ----------
      else if (action === ACTIONS.models) {
        const SUB = {
          fetch: "Add from /models endpoint",
          manual: "Add by typing ids",
          remove: "Remove existing models",
          cancel: "Cancel",
        } as const;
        const sub = await ui.select(
          `${provName} · manage models:`,
          [SUB.fetch, SUB.manual, SUB.remove, SUB.cancel],
          {},
        );
        if (!sub || sub === SUB.cancel) { ui.notify("Cancelled.", "info"); return; }

        if (sub === SUB.remove) {
          const existing = (provCfg.models ?? []).map((m) => m.id);
          if (existing.length === 0) { ui.notify("This provider has no models to remove.", "warning"); return; }
          const toDel = await pickModels(ctx, `Remove models · ${provName}`, existing, "delete");
          if (toDel === null) { ui.notify("Cancelled.", "info"); return; }
          if (toDel.length === 0) { ui.notify("No models selected for removal.", "info"); return; }
          const ok = await ui.confirm(
            `Remove ${toDel.length} model(s)?`,
            toDel.join(", "),
          );
          if (!ok) { ui.notify("Cancelled.", "info"); return; }
          const delSet = new Set(toDel);
          provCfg.models = (provCfg.models ?? []).filter((m) => !delSet.has(m.id));
          dirty = true;
          report.push(`✓ Removed ${toDel.length} model(s): ${toDel.join(", ")}`);
        } else {
          let newIds: string[] = [];
          if (sub === SUB.fetch) {
            const baseUrl = provCfg.baseUrl ?? "";
            const apiKey = typeof provCfg.apiKey === "string" ? provCfg.apiKey : "";
            if (!baseUrl) {
              ui.notify("This provider has no baseUrl. Use \"Add by typing ids\" instead.", "warning");
              return;
            }
            const fetched = await fetchModelsWithUI(ctx, baseUrl, apiKey);
            if (fetched.cancelled) { ui.notify("Cancelled.", "info"); return; }
            if (fetched.error) { ui.notify(`Fetch failed: ${fetched.error}`, "error"); return; }
            const existing = new Set((provCfg.models ?? []).map((m) => m.id));
            newIds = fetched.models.map((m) => m.id).filter((id) => !existing.has(id));
            if (newIds.length === 0) {
              ui.notify("No new models on the endpoint (all already present).", "warning");
              return;
            }
          } else {
            const manual = await ui.input("Model ids to add, comma-separated:");
            if (!manual?.trim()) { ui.notify("No models provided. Cancelled.", "info"); return; }
            newIds = manual.split(",").map((s) => s.trim()).filter(Boolean);
          }

          const selected = await pickModels(ctx, `Add models · ${provName}`, newIds, "add");
          if (selected === null) { ui.notify("Cancelled.", "info"); return; }
          if (selected.length === 0) { ui.notify("No models selected.", "info"); return; }

          const doEnrich = await ui.confirm(
            "Enrich model config?",
            "Use models.dev when available, then fall back to the built-in library. Fills thinkingLevelMap / contextWindow / maxTokens / input."
          );
          const customNames = new Set(Object.keys(config.providers));
          const enrichCtx = doEnrich ? await createEnrichContext(ctx, customNames) : undefined;
          provCfg.models = provCfg.models ?? [];
          for (const id of selected) {
            const m: LikeModel = { id };
            if (doEnrich && enrichCtx) {
              const [patches, src] = enrichModel(m, enrichCtx);
              if (src && patches.length > 0) {
                report.push(`✓ ${id} ← ${sourceRef(src)} +${patches.join(",")}`);
              } else if (src) {
                report.push(`= ${id} ← ${sourceRef(src)} already complete`);
              } else {
                report.push(`· ${id} — no models.dev or built-in match, id only`);
              }
            } else {
              report.push(`✓ ${id} (id only, not enriched)`);
            }
            provCfg.models.push(m);
          }
          dirty = true;
          report.unshift(`Added ${selected.length} model(s)`);
        }
      }

      // ---------- Edit connection ----------
      else if (action === ACTIONS.conn) {
        const field = await ui.select(
          `Edit which field of ${provName}?`,
          ["baseUrl", "apiKey", "Cancel"],
          {},
        );
        if (!field || field === "Cancel") { ui.notify("Cancelled.", "info"); return; }
        const current = typeof provCfg[field as "baseUrl" | "apiKey"] === "string"
          ? String(provCfg[field as "baseUrl" | "apiKey"])
          : "";

        // Title shows current value; empty keeps, "-" removes, Esc cancels
        const newVal = await ui.input(
          `${field} (current: ${current || "(empty)"} | empty keeps, - removes):`,
          "",
        );
        if (newVal === undefined) { ui.notify("Cancelled.", "info"); return; }
        const t = newVal.trim();
        let trimmed: string;
        if (t === "-") trimmed = "";
        else if (t === "") trimmed = current;
        else trimmed = t;

        if (trimmed === current) { ui.notify("No change.", "info"); return; }
        const ok = await ui.confirm(
          `Change ${provName}.${field}?`,
          `Old: ${current || "(empty)"}\nNew: ${trimmed || "(empty)"}`,
        );
        if (!ok) { ui.notify("Cancelled.", "info"); return; }
        if (trimmed === "") delete (provCfg as Record<string, unknown>)[field];
        else (provCfg as Record<string, unknown>)[field] = trimmed;
        dirty = true;
        report.push(`✓ ${field}: ${current || "(empty)"} → ${trimmed || "(removed)"}`);
      }

      // ---------- Enrich model config ----------
      else if (action === ACTIONS.enrich) {
        const models = provCfg.models ?? [];
        if (models.length === 0) { ui.notify("This provider has no models.", "warning"); return; }
        const MODES = {
          safe: "Fill missing fields only (safe)",
          overwrite: "Clear and re-enrich (overwrite matched fields)",
          cancel: "Cancel",
        } as const;
        const mode = await ui.select(
          `Enrich models of ${provName}:`,
          [MODES.safe, MODES.overwrite, MODES.cancel],
          {},
        );
        if (!mode || mode === MODES.cancel) { ui.notify("Cancelled.", "info"); return; }
        const overwrite = mode === MODES.overwrite;
        if (overwrite) {
          const ok = await ui.confirm(
            "Overwrite and re-enrich?",
            "Clears thinkingLevelMap / compat / maxTokens / contextWindow / input / name on each model, then re-matches models.dev first and built-in second. reasoning is kept."
          );
          if (!ok) { ui.notify("Cancelled.", "info"); return; }
        }
        const customNames = new Set(Object.keys(config.providers));
        const enrichCtx = await createEnrichContext(ctx, customNames);
        let changed = 0, noMatch = 0;
        for (const m of models) {
          if (overwrite) {
            delete m.thinkingLevelMap; delete m.compat; delete m.maxTokens;
            delete m.contextWindow; delete m.input; delete m.name;
          }
          const [patches, src] = enrichModel(m, enrichCtx);
          if (!src) {
            noMatch++;
            report.push(`· ${m.id} — no models.dev or built-in match, skipped`);
            continue;
          }
          if (patches.length > 0) {
            changed++;
            report.push(`✓ ${m.id} ← ${sourceRef(src)} +${patches.join(",")}`);
          } else {
            report.push(`= ${m.id} ← ${sourceRef(src)} already complete`);
          }
        }
        dirty = changed > 0;
        report.unshift(
          `Enriched ${changed}/${models.length} model(s)` +
          (noMatch > 0 ? `, no match ${noMatch}` : ""),
        );
      }

      // ---------- Delete provider ----------
      else if (action === ACTIONS.del) {
        const modelCount = (provCfg.models ?? []).length;
        const ok = await ui.confirm(
          `Delete provider ${provName}?`,
          `Permanently removes this provider and its ${modelCount} model(s). This cannot be undone.`,
        );
        if (!ok) { ui.notify("Cancelled.", "info"); return; }
        delete config.providers[provName];
        dirty = true;
        report.push(`✓ Deleted provider ${provName} (${modelCount} model(s))`);
      }

      // Write back
      if (dirty) {
        try { saveConfig(path, config); }
        catch (e) { ui.notify(`Failed to write models.json: ${(e as Error).message}`, "error"); return; }
      }
      const head = [
        `/edit-provider · ${provName}`,
        ...report,
        dirty ? "" : "(no changes)",
        dirty ? formatReloadHint() : "",
      ].filter(Boolean).join("\n");
      ui.notify(head, dirty ? "info" : "warning");
    },
  });
}
