/**
 * Shared enrichment logic.
 *
 * Priority:
 *   1. models.dev (cached online metadata), preferring canonical families
 *   2. pi built-in model registry
 *
 * Only missing fields are filled; existing user values are preserved unless
 * the caller explicitly clears fields first.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof LEVEL_ORDER[number];
export type ThinkingLevelMap = Record<string, string | null>;

/** pi-ai model cost rates: USD per 1M tokens. */
export interface ModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCostTier extends ModelCostRates {
  /** Use this tier for requests whose total input usage exceeds this token count. */
  inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
  tiers?: ModelCostTier[];
}

/** pi only validates these input modalities (see pi-ai Model.input). */
export const PI_INPUT_MODALITIES = ["text", "image"] as const;
export type PiInputModality = (typeof PI_INPUT_MODALITIES)[number];

export interface LikeModel {
  id: string;
  provider?: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap | null;
  compat?: Record<string, unknown>;
  maxTokens?: number;
  contextWindow?: number;
  /** pi-ai only accepts "text" | "image". */
  input?: PiInputModality[];
  /** USD / 1M tokens (pi usage accounting). */
  cost?: ModelCost;
  /** Optional explicit family override, e.g. "openai" / "xai" / "zhipuai". */
  modelFamily?: string;
}

export interface ProviderConfig {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  /** Prefer this model family when bare ids collide across resellers. */
  modelFamily?: string;
  models?: LikeModel[];
  [k: string]: unknown;
}

export interface ModelsJsonConfig {
  providers: Record<string, ProviderConfig>;
}

export interface EnrichSource extends LikeModel {
  /** Human-readable source name for reports, e.g. models.dev or built-in/openai. */
  sourceLabel?: string;
}

export interface EnrichContext {
  builtIn: Map<string, LikeModel>;
  modelsDev?: ModelsDevIndex;
}

export interface EnrichOptions {
  /** Custom provider name from models.json. */
  providerName?: string;
  /** Provider config (may include modelFamily). */
  providerCfg?: ProviderConfig;
  /** Explicit preferred families, highest priority. */
  preferredFamilies?: string[];
}

interface ModelsDevLimit {
  context?: number;
  input?: number;
  output?: number;
}

interface ModelsDevModalities {
  input?: string[];
  output?: string[];
}

interface ModelsDevReasoningOption {
  type?: string;
  values?: string[];
}

interface ModelsDevRawModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  modalities?: ModelsDevModalities;
  limit?: ModelsDevLimit;
  /** models.dev/api.json pricing, usually USD per 1M tokens. */
  cost?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ModelsDevProvider {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevRawModel>;
}

interface ModelsDevSource {
  key: string;
  bare: string;
  model: EnrichSource;
  reasoningOptions?: ModelsDevReasoningOption[];
  rank: number;
  /** Provider id derived from models.dev key / sourceLabel / model.id. */
  providerIds: string[];
  /**
   * Hosting catalog provider (models.dev/<host> or "models.dev" for top-level).
   * Used for preferred-family scoring so resellers that rehost qwen/foo do not
   * count as official qwen/alibaba merely because the path mentions qwen.
   */
  hostProvider: string;
}

export interface ModelsDevIndex {
  exact: Map<string, ModelsDevSource[]>;
  bare: Map<string, ModelsDevSource[]>;
}

const MODELS_DEV_MODELS_URL = "https://models.dev/models.json";
const MODELS_DEV_API_URL = "https://models.dev/api.json";
const CACHE_DIR = () => join(homedir(), ".cache", "pi-model-manager");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Authoritative / first-party families. Reseller / gateway providers are not listed.
 * Used to prefer openai/gpt-5.5 over vivgrid/gpt-5.5 when only a bare id is given.
 */
const CANONICAL_FAMILIES = new Set([
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "xai",
  "x-ai",
  "zhipuai",
  "zai",
  "z-ai",
  "deepseek",
  "mistral",
  "groq",
  "moonshotai",
  "moonshot",
  "minimax",
  "amazon-bedrock",
  "cohere",
  "meta",
  "qwen",
  "alibaba",
  "alibaba-cn",
  "alibaba-cloud",
  "dashscope",
  // ByteDance Doubao / Volcengine Ark
  "volcengine",
  "bytedance",
  "doubao",
  // Xiaomi MiMo
  "xiaomi",
  "xiaomimimo",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
  "nvidia",
  "perplexity",
  "ai21",
  "cerebras",
  "together",
  "fireworks",
  "huggingface",
]);

/** Completeness score for thinkingLevelMap. Completeness is a weak signal only. */
export function scoreMap(map?: ThinkingLevelMap | null): number {
  if (!map) return -1;
  let s = 0;
  for (const lvl of LEVEL_ORDER) {
    const v = map[lvl];
    if (v === undefined) continue;
    s += 1;
    if (v !== null) s += 0.5;
  }
  // Prefer maps that explicitly enable max/xhigh, but keep weight modest so
  // reseller "complete" maps cannot beat canonical sparse maps alone.
  if (map.max !== undefined && map.max !== null) s += 2;
  if (map.xhigh !== undefined && map.xhigh !== null) s += 1;
  return s;
}

/** Distinct effort values (ignoring null/off aliases). Higher = more useful map. */
function mapDiversity(map?: ThinkingLevelMap | null): number {
  if (!map) return 0;
  const values = new Set<string>();
  for (const lvl of LEVEL_ORDER) {
    const v = map[lvl];
    if (typeof v === "string" && v.length > 0) values.add(v.toLowerCase());
  }
  return values.size;
}

/** Shallow-merge compat: src as base, user fields win. */
export function mergeCompat(
  src: Record<string, unknown> | undefined,
  user: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!src && !user) return undefined;
  if (!src) return user;
  if (!user) return { ...src };
  return { ...src, ...user };
}

function normalizeFamily(family: string): string {
  return normalizeId(providerAlias(family)).replace(/\/.*$/, "");
}

function normalizeFamilies(list: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw) continue;
    const f = normalizeFamily(String(raw));
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
    // Keep common aliases paired so scoring matches either form.
    const aliasGroups: string[][] = [
      ["xai", "x-ai"],
      ["zhipuai", "zai", "z-ai"],
      ["alibaba", "alibaba-cn", "alibaba-cloud", "dashscope", "qwen"],
      ["volcengine", "bytedance", "doubao"],
      ["xiaomi", "xiaomimimo", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"],
      ["moonshotai", "moonshot"],
    ];
    for (const group of aliasGroups) {
      if (!group.includes(f)) continue;
      for (const a of group) {
        if (!seen.has(a)) {
          seen.add(a);
          out.push(a);
        }
      }
    }
  }
  return out;
}

/**
 * Infer likely first-party families from a bare model id.
 * This is the main fix for bare ids like gpt-5.5 / grok-4.5 / glm-5.2.
 */
export function inferFamiliesFromModelId(id: string): string[] {
  const bare = bareId(id);
  if (!bare) return [];

  if (/^(gpt-|o[1-9]|chatgpt|openai)/.test(bare)) return normalizeFamilies(["openai"]);
  if (/^claude/.test(bare)) return normalizeFamilies(["anthropic"]);
  if (/^(gemini|gemma)/.test(bare)) return normalizeFamilies(["google", "google-vertex"]);
  if (/^grok/.test(bare)) return normalizeFamilies(["xai", "x-ai"]);
  if (/^(glm-|chatglm)/.test(bare)) return normalizeFamilies(["zhipuai", "zai", "z-ai"]);
  if (/^deepseek/.test(bare)) return normalizeFamilies(["deepseek"]);
  // Qwen family + thinking variants qwq/qvq (do not require "qwen" prefix).
  if (/^(qwen|qwq|qvq)/.test(bare)) {
    return normalizeFamilies(["alibaba", "qwen", "dashscope", "alibaba-cn"]);
  }
  // ByteDance Doubao / Volcengine Ark chat models.
  // Prefer doubao-* ; also seed-N.M chat ids, but not generic "seedream/seedance" media alone
  // still maps to bytedance when those prefixes appear.
  if (/^doubao/.test(bare)) {
    return normalizeFamilies(["volcengine", "bytedance", "doubao"]);
  }
  if (/^(seedance|seedream)/.test(bare)) {
    return normalizeFamilies(["bytedance", "volcengine", "doubao"]);
  }
  // seed-1.6 / seed-1.8 / seed-oss-... (chat/OSS), avoid bare "seed" alone.
  if (/^seed-(\d|oss)/.test(bare)) {
    return normalizeFamilies(["volcengine", "bytedance", "doubao"]);
  }
  // Xiaomi MiMo (mimo-v2*, xiaomi-mimo-*, coding-xiaomi-mimo-*).
  if (
    /^mimo-/.test(bare) ||
    /^xiaomi-mimo/.test(bare) ||
    /^xiaomi/.test(bare) ||
    /^coding-xiaomi/.test(bare)
  ) {
    return normalizeFamilies(["xiaomi", "xiaomimimo"]);
  }
  if (/^(mistral|mixtral|codestral|pixtral|ministral|magistral)/.test(bare)) {
    return normalizeFamilies(["mistral"]);
  }
  if (/^(kimi|moonshot)/.test(bare)) return normalizeFamilies(["moonshotai", "moonshot"]);
  if (/^minimax/.test(bare) || /^abab/.test(bare)) return normalizeFamilies(["minimax"]);
  if (/^(llama|meta-llama)/.test(bare)) return normalizeFamilies(["meta"]);
  if (/^command/.test(bare)) return normalizeFamilies(["cohere"]);
  if (/^sonar/.test(bare)) return normalizeFamilies(["perplexity"]);
  return [];
}

/** Resolve preferred families for a model under an optional provider. */
export function resolvePreferredFamilies(
  model: LikeModel,
  opts?: EnrichOptions,
): string[] {
  return normalizeFamilies([
    ...(opts?.preferredFamilies ?? []),
    model.modelFamily,
    opts?.providerCfg?.modelFamily,
    // If the model id is already namespaced (openai/gpt-5.5), that provider wins.
    model.id.includes("/") ? model.id.split("/")[0] : undefined,
    ...inferFamiliesFromModelId(model.id),
  ]);
}

/** Build id → best built-in model (skip custom providers). Prefer canonical families. */
export function buildDict(all: LikeModel[], customProviderNames: Set<string>): Map<string, LikeModel> {
  const dict = new Map<string, LikeModel>();
  for (const m of all) {
    if (!m?.id) continue;
    if (m.provider && customProviderNames.has(m.provider)) continue;

    const keys = new Set<string>();
    const id = normalizeId(m.id);
    const bare = bareId(m.id);
    keys.add(id);
    keys.add(bare);
    if (m.provider) {
      keys.add(normalizeId(`${m.provider}/${m.id}`));
      keys.add(normalizeId(`${m.provider}/${bare}`));
    }

    for (const key of keys) {
      if (!key) continue;
      const prev = dict.get(key);
      if (!prev || builtInBetter(m, prev)) dict.set(key, m);
    }
  }
  return dict;
}

function builtInBetter(a: LikeModel, b: LikeModel): boolean {
  const aCanon = a.provider && CANONICAL_FAMILIES.has(normalizeFamily(a.provider)) ? 1 : 0;
  const bCanon = b.provider && CANONICAL_FAMILIES.has(normalizeFamily(b.provider)) ? 1 : 0;
  if (aCanon !== bCanon) return aCanon > bCanon;
  // Prefer native openai over azure/github wrappers for the same bare id.
  const aProv = normalizeFamily(a.provider ?? "");
  const bProv = normalizeFamily(b.provider ?? "");
  const rank = (p: string) => {
    if (p === "openai" || p === "anthropic" || p === "xai" || p === "x-ai" || p === "zhipuai" || p === "zai") return 3;
    if (p === "google" || p === "deepseek" || p === "mistral") return 2;
    if (CANONICAL_FAMILIES.has(p)) return 1;
    return 0;
  };
  if (rank(aProv) !== rank(bProv)) return rank(aProv) > rank(bProv);
  return scoreMap(a.thinkingLevelMap) > scoreMap(b.thinkingLevelMap);
}

/** Build dict from ctx.modelRegistry. */
export function dictFromRegistry(ctx: ExtensionContext, customProviderNames: Set<string>): Map<string, LikeModel> {
  const all = (ctx.modelRegistry?.getAll?.() ?? []) as LikeModel[];
  return buildDict(all, customProviderNames);
}

export async function createEnrichContext(
  ctx: ExtensionContext,
  customProviderNames: Set<string>,
): Promise<EnrichContext> {
  const builtIn = dictFromRegistry(ctx, customProviderNames);
  const modelsDev = await getModelsDevIndex().catch(() => undefined);
  return { builtIn, modelsDev };
}

function normalizeId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^~+/, "")
    .replace(/:free$/, "")
    .replace(/_/g, "-");
}

function providerAlias(id: string): string {
  return id
    .replace(/^x-ai\//, "xai/")
    .replace(/^z-ai\//, "zhipuai/")
    .replace(/^zai\//, "zhipuai/")
    .replace(/^qwen\//, "alibaba/")
    .replace(/^moonshotai\//, "moonshotai/")
    .replace(/^moonshot\//, "moonshotai/")
    .replace(/^xiaomimimo\//, "xiaomi/")
    .replace(/^doubao\//, "volcengine/")
    .replace(/^bytedance\//, "volcengine/");
}

function bareId(id: string): string {
  const n = normalizeId(providerAlias(id));
  const parts = n.split("/");
  return parts[parts.length - 1] || n;
}

function candidateKeys(id: string): string[] {
  const n = normalizeId(id);
  const aliased = normalizeId(providerAlias(n));
  const keys = new Set<string>([n, aliased]);
  if (n.includes("/")) keys.add(bareId(n));
  return [...keys].filter(Boolean);
}

function cachePath(name: string): string {
  return join(CACHE_DIR(), name);
}

function readCache<T>(name: string, allowStale = false): T | undefined {
  const path = cachePath(name);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { ts?: number; data?: T };
    if (!allowStale && raw.ts && Date.now() - raw.ts > CACHE_TTL_MS) return undefined;
    return raw.data;
  } catch {
    return undefined;
  }
}

function writeCache<T>(name: string, data: T): void {
  mkdirSync(CACHE_DIR(), { recursive: true });
  writeFileSync(cachePath(name), JSON.stringify({ ts: Date.now(), data }), "utf-8");
}

async function fetchJsonWithCache<T>(url: string, cacheName: string): Promise<T> {
  const fresh = readCache<T>(cacheName);
  if (fresh) return fresh;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "@superjeason/pi-model-manager",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = (await res.json()) as T;
    writeCache(cacheName, data);
    return data;
  } catch (e) {
    const stale = readCache<T>(cacheName, true);
    if (stale) return stale;
    throw e;
  }
}

function mapEffortValuesToThinkingLevelMap(values: unknown[], mandatory = false): ThinkingLevelMap | undefined {
  const set = new Set(
    values
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.toLowerCase()),
  );
  if (set.size === 0) return undefined;

  const has = (...xs: string[]) => xs.find((x) => set.has(x));
  const nearest = (...xs: string[]) => has(...xs) ?? undefined;

  const off = nearest("none", "off");
  const low = nearest("low", "minimal", "medium", "high", "xhigh", "max");
  const medium = nearest("medium", "high", "low", "xhigh", "max", "minimal");
  const high = nearest("high", "xhigh", "max", "medium", "low");
  const xhigh = nearest("xhigh", "max", "high", "medium", "low");
  const max = nearest("max", "xhigh", "high", "medium", "low");
  const minimal = nearest("minimal", "low", "medium", "high", "xhigh", "max");

  const map: ThinkingLevelMap = {};
  // Always record off: either mapped value, or null when efforts exist but "none/off" is absent.
  map.off = off ?? null;
  if (minimal) map.minimal = minimal;
  if (low) map.low = low;
  if (medium) map.medium = medium;
  if (high) map.high = high;
  if (xhigh) map.xhigh = xhigh;
  if (max) map.max = max;
  // Avoid emitting maps that only set off:null with nothing else useful.
  if (!minimal && !low && !medium && !high && !xhigh && !max) {
    if (mandatory) return { off: map.off };
    return off ? { off } : undefined;
  }
  return map;
}

function optionsToThinkingLevelMap(options: ModelsDevReasoningOption[] | undefined, reasoning?: boolean): ThinkingLevelMap | undefined {
  if (!reasoning) return undefined;
  const effort = options?.find((o) => o?.type === "effort" && Array.isArray(o.values));
  if (!effort?.values?.length) return undefined;
  return mapEffortValuesToThinkingLevelMap(effort.values);
}

/**
 * pi-ai Model.input is typed as ("text" | "image")[].
 * models.dev modalities often include pdf/audio/video — drop unsupported values
 * so models.json validation does not fail.
 */
export function sanitizePiInputModalities(raw: unknown): PiInputModality[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set<string>(PI_INPUT_MODALITIES);
  const out: PiInputModality[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const n = v.trim().toLowerCase();
    if (!allowed.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n as PiInputModality);
  }
  // Prefer at least text when source listed inputs but none survived filtering.
  if (out.length === 0 && raw.length > 0) return ["text"];
  return out.length > 0 ? out : undefined;
}

function numOr(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** True when cost is missing or a zero placeholder (common in custom providers). */
export function isPlaceholderCost(cost?: ModelCost | null): boolean {
  if (!cost) return true;
  const baseZero =
    numOr(cost.input) === 0 &&
    numOr(cost.output) === 0 &&
    numOr(cost.cacheRead) === 0 &&
    numOr(cost.cacheWrite) === 0;
  if (!baseZero) return false;
  if (!cost.tiers?.length) return true;
  return cost.tiers.every(
    (t) =>
      numOr(t.input) === 0 &&
      numOr(t.output) === 0 &&
      numOr(t.cacheRead) === 0 &&
      numOr(t.cacheWrite) === 0,
  );
}

function ratesFromUnknown(raw: Record<string, unknown> | undefined): ModelCostRates | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  // Require at least input or output so we don't invent empty objects.
  if (raw.input === undefined && raw.output === undefined) return undefined;
  return {
    input: numOr(raw.input),
    output: numOr(raw.output),
    cacheRead: numOr(raw.cache_read ?? raw.cacheRead),
    cacheWrite: numOr(raw.cache_write ?? raw.cacheWrite),
  };
}

/**
 * Convert models.dev cost blobs into pi ModelCost.
 * models.dev uses snake_case and optional context tiers / context_over_200k.
 */
export function convertModelsDevCost(raw: unknown): ModelCost | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const base = ratesFromUnknown(obj);
  if (!base) return undefined;

  const tiers: ModelCostTier[] = [];
  const seen = new Set<number>();

  const pushTier = (above: number, rates: ModelCostRates | undefined) => {
    if (!rates || !Number.isFinite(above) || above <= 0 || seen.has(above)) return;
    seen.add(above);
    tiers.push({ ...rates, inputTokensAbove: above });
  };

  if (Array.isArray(obj.tiers)) {
    for (const t of obj.tiers) {
      if (!t || typeof t !== "object") continue;
      const tr = t as Record<string, unknown>;
      const tierMeta = tr.tier && typeof tr.tier === "object" ? (tr.tier as Record<string, unknown>) : undefined;
      const above =
        numOr(tr.inputTokensAbove, NaN) ||
        numOr(tierMeta?.size, NaN) ||
        numOr(tr.context, NaN) ||
        numOr(tr.threshold, NaN);
      pushTier(above, ratesFromUnknown(tr));
    }
  }

  // Legacy shortcut used by several providers in api.json.
  if (obj.context_over_200k && typeof obj.context_over_200k === "object") {
    pushTier(200_000, ratesFromUnknown(obj.context_over_200k as Record<string, unknown>));
  }

  tiers.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
  return tiers.length > 0 ? { ...base, tiers } : base;
}

function costScore(cost?: ModelCost | null): number {
  if (!cost || isPlaceholderCost(cost)) return 0;
  let s = 2;
  if (cost.cacheRead > 0 || cost.cacheWrite > 0) s += 1;
  if (cost.tiers?.length) s += Math.min(3, cost.tiers.length);
  return s;
}

function cloneCost(cost: ModelCost): ModelCost {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    ...(cost.tiers?.length
      ? {
          tiers: cost.tiers.map((t) => ({
            input: t.input,
            output: t.output,
            cacheRead: t.cacheRead,
            cacheWrite: t.cacheWrite,
            inputTokensAbove: t.inputTokensAbove,
          })),
        }
      : {}),
  };
}

function collectProviderIds(key: string, actualId: string, sourceLabel: string): string[] {
  const ids = new Set<string>();
  const add = (v?: string) => {
    if (!v) return;
    const n = normalizeFamily(v);
    if (n) ids.add(n);
  };

  if (key.includes("/")) add(key.split("/")[0]);
  if (actualId.includes("/")) add(actualId.split("/")[0]);

  const label = sourceLabel || "";
  if (label === "models.dev") {
    // Top-level models.json entries are usually already namespaced (openai/gpt-5.5).
  } else if (label.startsWith("models.dev/")) {
    add(label.slice("models.dev/".length));
  } else {
    add(label);
  }
  return [...ids];
}

function rawToLikeModel(
  id: string,
  raw: ModelsDevRawModel,
  sourceLabel: string,
  rank: number,
): ModelsDevSource {
  // Prefer the map key when it is more specific (e.g. models.json "openai/gpt-5.5"
  // while raw.id is only "gpt-5.5"). Keep a display id that still looks natural.
  const rawId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  const mapKey = id.trim();
  const actualId =
    mapKey.includes("/") && (!rawId || !rawId.includes("/"))
      ? mapKey
      : rawId || mapKey;
  const reasoningOptions = Array.isArray(raw.reasoning_options) ? raw.reasoning_options : undefined;
  const model: EnrichSource = {
    id: actualId,
    provider: sourceLabel,
    sourceLabel,
  };
  if (typeof raw.name === "string") model.name = raw.name;
  if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;
  const thinkingLevelMap = optionsToThinkingLevelMap(reasoningOptions, raw.reasoning);
  if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
  if (typeof raw.limit?.output === "number" && raw.limit.output > 0) model.maxTokens = raw.limit.output;
  if (typeof raw.limit?.context === "number" && raw.limit.context > 0) model.contextWindow = raw.limit.context;
  // models.dev may list pdf/audio/video; pi Model.input only allows text|image.
  const input = sanitizePiInputModalities(raw.modalities?.input);
  if (input) model.input = input;
  const cost = convertModelsDevCost(raw.cost);
  if (cost) model.cost = cost;
  // Index under both the namespaced map key and the bare/raw id when they differ.
  const key = normalizeId(mapKey.includes("/") ? mapKey : actualId);
  const providerIds = collectProviderIds(key, actualId, sourceLabel);
  let hostProvider = "";
  if (sourceLabel === "models.dev") hostProvider = "models.dev";
  else if (sourceLabel.startsWith("models.dev/")) hostProvider = normalizeFamily(sourceLabel.slice("models.dev/".length));
  else hostProvider = normalizeFamily(sourceLabel);
  return {
    key,
    bare: bareId(actualId),
    model,
    reasoningOptions,
    rank,
    providerIds,
    hostProvider,
  };
}

function addSource(map: Map<string, ModelsDevSource[]>, key: string, src: ModelsDevSource): void {
  const list = map.get(key) ?? [];
  list.push(src);
  map.set(key, list);
}

/**
 * Score a models.dev candidate.
 * Family/canonical match dominates; map completeness is only a tie-breaker.
 */
function sourceScore(src: ModelsDevSource, preferredFamilies: string[] = []): number {
  let s = src.rank; // models.json canonical = 1000, api provider rows = 100

  const preferred = new Set(preferredFamilies.map(normalizeFamily));
  const host = normalizeFamily(src.hostProvider || "");
  const isTopLevel = src.model.sourceLabel === "models.dev" || host === "models.dev";

  // Hosting provider is the only thing that earns the big preferred-family bonus.
  // Path namespaces like abacus's qwen/qwq-32b must NOT count as official qwen.
  const hostIsPreferred = !!host && host !== "models.dev" && preferred.has(host);
  const topLevelPreferred =
    isTopLevel &&
    src.key.includes("/") &&
    preferred.has(normalizeFamily(src.key.split("/")[0]));
  const isPreferred = hostIsPreferred || topLevelPreferred;

  const hostIsCanonical = !!host && host !== "models.dev" && CANONICAL_FAMILIES.has(host);
  const topLevelCanonical =
    isTopLevel &&
    src.key.includes("/") &&
    CANONICAL_FAMILIES.has(normalizeFamily(src.key.split("/")[0]));
  const isCanonical = hostIsCanonical || topLevelCanonical;

  // Strong preference for inferred / configured family (openai vs vivgrid).
  if (isPreferred) s += 5000;
  // Prefer first-party families over gateways/resellers.
  if (isCanonical) s += 800;
  // Top-level models.dev/models.json entries beat provider-api clones.
  if (isTopLevel) s += 300;

  // Namespaced key matching preferred family is only a small tie-break, never the main signal.
  if (src.key.includes("/")) {
    const fam = normalizeFamily(src.key.split("/")[0]);
    if (preferred.has(fam)) s += 50;
  }

  // Weak metadata signals only.
  if (src.model.thinkingLevelMap) {
    s += 15 + scoreMap(src.model.thinkingLevelMap) * 2;
    // Prefer maps that actually differentiate levels (avoid all-high maps).
    s += mapDiversity(src.model.thinkingLevelMap) * 3;
  }
  if (src.model.reasoning) s += 10;
  if (src.model.contextWindow) s += 3;
  if (src.model.maxTokens) s += 3;
  s += costScore(src.model.cost);
  return s;
}

function pickBest(
  sources: ModelsDevSource[] | undefined,
  preferredFamilies: string[] = [],
): ModelsDevSource | undefined {
  if (!sources?.length) return undefined;
  return [...sources].sort((a, b) => sourceScore(b, preferredFamilies) - sourceScore(a, preferredFamilies))[0];
}

function buildModelsDevIndex(
  modelsJson: Record<string, ModelsDevRawModel>,
  apiJson: Record<string, ModelsDevProvider>,
): ModelsDevIndex {
  const exact = new Map<string, ModelsDevSource[]>();
  const bare = new Map<string, ModelsDevSource[]>();
  const apiExact = new Map<string, ModelsDevSource[]>();
  const apiBare = new Map<string, ModelsDevSource[]>();

  // First collect API/provider records. They often contain reasoning_options
  // that are missing from the canonical models.json record.
  for (const [providerId, provider] of Object.entries(apiJson ?? {})) {
    const models = provider?.models ?? {};
    for (const [id, raw] of Object.entries(models)) {
      const src = rawToLikeModel(id, raw, `models.dev/${providerId}`, 100);
      // Ensure provider id is always present even for bare model keys.
      if (!src.providerIds.includes(normalizeFamily(providerId))) {
        src.providerIds.push(normalizeFamily(providerId));
      }
      addSource(apiExact, src.key, src);
      addSource(apiBare, src.bare, src);
    }
  }

  // Add canonical model records with a high rank, enriched with the best
  // matching API reasoning map when available — but prefer same-family options.
  for (const [id, raw] of Object.entries(modelsJson ?? {})) {
    const src = rawToLikeModel(id, raw, "models.dev", 1000);
    const families = normalizeFamilies([
      ...src.providerIds,
      ...inferFamiliesFromModelId(src.bare),
      src.key.includes("/") ? src.key.split("/")[0] : undefined,
    ]);
    const optionSrc =
      pickBest(apiExact.get(src.key), families) ??
      pickBest(apiBare.get(src.bare), families);
    // Prefer same-family API rows that carry reasoning_options / cost, since
    // models.json often omits both.
    if (!src.model.thinkingLevelMap && optionSrc?.model.thinkingLevelMap) {
      src.model.thinkingLevelMap = { ...optionSrc.model.thinkingLevelMap };
    }
    if (src.model.reasoning === undefined && optionSrc?.model.reasoning !== undefined) {
      src.model.reasoning = optionSrc.model.reasoning;
    }
    if (isPlaceholderCost(src.model.cost) && optionSrc?.model.cost) {
      src.model.cost = cloneCost(optionSrc.model.cost);
    }
    addSource(exact, src.key, src);
    addSource(bare, src.bare, src);
  }

  // Keep provider/API records as fallback, especially for provider-specific ids
  // that do not exist in models.json.
  for (const sources of apiExact.values()) {
    for (const src of sources) {
      addSource(exact, src.key, src);
      addSource(bare, src.bare, src);
    }
  }

  return { exact, bare };
}

export async function getModelsDevIndex(): Promise<ModelsDevIndex> {
  const [modelsJson, apiJson] = await Promise.all([
    fetchJsonWithCache<Record<string, ModelsDevRawModel>>(MODELS_DEV_MODELS_URL, "models-dev-models.json"),
    fetchJsonWithCache<Record<string, ModelsDevProvider>>(MODELS_DEV_API_URL, "models-dev-api.json"),
  ]);
  return buildModelsDevIndex(modelsJson, apiJson);
}

function sourceMatchesFamilies(src: ModelsDevSource, families: string[]): boolean {
  if (!families.length) return false;
  const preferred = new Set(families.map(normalizeFamily));
  return src.providerIds.some((p) => preferred.has(normalizeFamily(p)));
}

export function lookupModelsDevModel(
  index: ModelsDevIndex | undefined,
  id: string,
  preferredFamilies: string[] = [],
): EnrichSource | undefined {
  if (!index) return undefined;
  const families = normalizeFamilies([
    ...preferredFamilies,
    ...inferFamiliesFromModelId(id),
    id.includes("/") ? id.split("/")[0] : undefined,
  ]);
  const bare = bareId(id);
  const pool: ModelsDevSource[] = [];

  // Collect exact / aliased keys (including pure bare keys).
  for (const key of candidateKeys(id)) {
    const list = index.exact.get(key);
    if (list?.length) pool.push(...list);
  }

  // Explicit family/bare probes (openai/gpt-5.5 even when user only has gpt-5.5).
  for (const fam of families) {
    for (const key of candidateKeys(`${fam}/${bare}`)) {
      const list = index.exact.get(key);
      if (list?.length) pool.push(...list);
    }
  }

  // Bare id pool always participates so reseller exact hits cannot hide a better
  // namespaced official entry (e.g. volcengine/doubao-* vs qiniu-ai/doubao-*).
  const bareList = index.bare.get(bare);
  if (bareList?.length) pool.push(...bareList);

  if (!pool.length) return undefined;

  // Dedup by sourceLabel+key+rank identity.
  const uniq = new Map<string, ModelsDevSource>();
  for (const src of pool) {
    const k = `${src.model.sourceLabel ?? ""}::${src.key}::${src.rank}`;
    const prev = uniq.get(k);
    if (!prev || sourceScore(src, families) > sourceScore(prev, families)) uniq.set(k, src);
  }

  const best = pickBest([...uniq.values()], families);
  if (!best) return undefined;

  // If we only found resellers but preferred families are known, still return the
  // best available match (better than nothing). Family preference already applied.
  void sourceMatchesFamilies;
  return best.model;
}

function lookupBuiltInModel(
  builtIn: Map<string, LikeModel>,
  id: string,
  preferredFamilies: string[] = [],
): EnrichSource | undefined {
  const families = normalizeFamilies([
    ...preferredFamilies,
    ...inferFamiliesFromModelId(id),
  ]);
  const bare = bareId(id);
  const candidates: LikeModel[] = [];

  const tryKey = (key?: string) => {
    if (!key) return;
    const hit = builtIn.get(normalizeId(key)) ?? builtIn.get(key);
    if (hit) candidates.push(hit);
  };

  for (const key of candidateKeys(id)) tryKey(key);
  tryKey(bare);
  for (const fam of families) {
    tryKey(`${fam}/${bare}`);
    tryKey(`${fam}/${id}`);
  }

  if (candidates.length === 0) return undefined;

  // Dedup by provider+id, then pick best.
  const uniq = new Map<string, LikeModel>();
  for (const c of candidates) {
    const k = `${c.provider ?? ""}::${c.id}`;
    const prev = uniq.get(k);
    if (!prev || builtInBetter(c, prev)) uniq.set(k, c);
  }

  const ranked = [...uniq.values()].sort((a, b) => {
    const aFam = normalizeFamily(a.provider ?? "");
    const bFam = normalizeFamily(b.provider ?? "");
    const aPref = families.includes(aFam) ? 1 : 0;
    const bPref = families.includes(bFam) ? 1 : 0;
    if (aPref !== bPref) return bPref - aPref;
    if (builtInBetter(a, b)) return -1;
    if (builtInBetter(b, a)) return 1;
    return 0;
  });

  const best = ranked[0];
  if (!best) return undefined;
  return {
    ...best,
    sourceLabel: best.provider ? `built-in/${best.provider}` : "built-in",
  };
}

/**
 * Fill missing fields on one model from a source.
 * Only touches unset fields (idempotent).
 */
function applyModelPatch(m: LikeModel, src: LikeModel): string[] {
  const patches: string[] = [];
  if (!m.thinkingLevelMap && src.thinkingLevelMap) {
    m.thinkingLevelMap = { ...src.thinkingLevelMap };
    patches.push("thinkingLevelMap");
  }
  if (m.reasoning === undefined && src.reasoning !== undefined) {
    m.reasoning = src.reasoning;
    patches.push("reasoning");
  }
  const merged = mergeCompat(src.compat, m.compat);
  if (merged && JSON.stringify(merged) !== JSON.stringify(m.compat ?? {})) {
    m.compat = merged;
    patches.push("compat");
  }
  if (m.maxTokens === undefined && src.maxTokens !== undefined) {
    m.maxTokens = src.maxTokens;
    patches.push("maxTokens");
  }
  if (m.contextWindow === undefined && src.contextWindow !== undefined) {
    m.contextWindow = src.contextWindow;
    patches.push("contextWindow");
  }
  // Always coerce existing/source input to pi-safe modalities (strip pdf/audio/video).
  const srcInput = sanitizePiInputModalities(src.input);
  const curInput = sanitizePiInputModalities(m.input);
  if (m.input !== undefined && curInput && JSON.stringify(m.input) !== JSON.stringify(curInput)) {
    m.input = curInput;
    patches.push("input");
  } else if (m.input === undefined && srcInput) {
    m.input = srcInput;
    patches.push("input");
  } else if (m.input !== undefined && !curInput && srcInput) {
    m.input = srcInput;
    patches.push("input");
  }
  if (m.name === undefined && src.name) {
    m.name = src.name;
    patches.push("name");
  }
  // Fill cost when missing or all-zero placeholder (custom providers often ship zeros).
  if (src.cost && !isPlaceholderCost(src.cost) && isPlaceholderCost(m.cost)) {
    m.cost = cloneCost(src.cost);
    patches.push("cost");
  }
  return patches;
}

/** Clear enrichable fields so a subsequent enrichModel can rewrite them. */
export function clearEnrichableFields(m: LikeModel): void {
  delete m.thinkingLevelMap;
  delete m.compat;
  delete m.maxTokens;
  delete m.contextWindow;
  delete m.input;
  delete m.name;
  delete m.cost;
  // Keep reasoning + id + modelFamily.
}

/**
 * Prefer models.dev if it has a match; otherwise fall back to pi built-ins.
 * When models.dev matches, still layer built-in `compat` (and any still-missing
 * fields) on top — models.dev rarely has pi-specific compat flags.
 * Returns [patched field names, primary source model].
 */
export function enrichModel(
  m: LikeModel,
  ctx: EnrichContext | Map<string, LikeModel>,
  opts?: EnrichOptions,
): [string[], EnrichSource | undefined] {
  const enrichCtx: EnrichContext = ctx instanceof Map ? { builtIn: ctx } : ctx;
  const families = resolvePreferredFamilies(m, opts);

  const modelsDevSrc = lookupModelsDevModel(enrichCtx.modelsDev, m.id, families);
  const builtInSrc = lookupBuiltInModel(enrichCtx.builtIn, m.id, families);

  if (modelsDevSrc) {
    const patches = applyModelPatch(m, modelsDevSrc);
    if (builtInSrc) {
      // Secondary pass: fill remaining gaps (especially compat) from built-in.
      for (const p of applyModelPatch(m, builtInSrc)) {
        if (!patches.includes(p)) patches.push(p);
      }
    }
    return [patches, modelsDevSrc];
  }

  if (!builtInSrc) return [[], undefined];
  return [applyModelPatch(m, builtInSrc), builtInSrc];
}
