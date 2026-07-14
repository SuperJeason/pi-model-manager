/**
 * Shared enrichment logic.
 *
 * Priority:
 *   1. models.dev (cached online metadata)
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

export interface LikeModel {
  id: string;
  provider?: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap | null;
  compat?: Record<string, unknown>;
  maxTokens?: number;
  contextWindow?: number;
  input?: string[];
}

export interface ModelsJsonConfig {
  providers: Record<string, {
    baseUrl?: string;
    api?: string;
    apiKey?: string;
    authHeader?: boolean;
    headers?: Record<string, string>;
    models?: LikeModel[];
    [k: string]: unknown;
  }>;
}

export interface EnrichSource extends LikeModel {
  /** Human-readable source name for reports, e.g. models.dev or built-in/openai. */
  sourceLabel?: string;
}

export interface EnrichContext {
  builtIn: Map<string, LikeModel>;
  modelsDev?: ModelsDevIndex;
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
}

export interface ModelsDevIndex {
  exact: Map<string, ModelsDevSource[]>;
  bare: Map<string, ModelsDevSource[]>;
}

const MODELS_DEV_MODELS_URL = "https://models.dev/models.json";
const MODELS_DEV_API_URL = "https://models.dev/api.json";
const CACHE_DIR = () => join(homedir(), ".cache", "pi-model-manager");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Completeness score for thinkingLevelMap; prefers maps that define max. */
export function scoreMap(map?: ThinkingLevelMap | null): number {
  if (!map) return -1;
  let s = 0;
  for (const lvl of LEVEL_ORDER) {
    const v = map[lvl];
    if (v === undefined) continue;
    s += 1;
    if (v !== null) s += 0.5;
  }
  if (map.max !== undefined && map.max !== null) s += 5;
  return s;
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

/** Build id → best built-in model (skip custom providers). */
export function buildDict(all: LikeModel[], customProviderNames: Set<string>): Map<string, LikeModel> {
  const dict = new Map<string, LikeModel>();
  for (const m of all) {
    if (!m?.id) continue;
    if (m.provider && customProviderNames.has(m.provider)) continue;
    const prev = dict.get(m.id);
    if (!prev || scoreMap(m.thinkingLevelMap) > scoreMap(prev.thinkingLevelMap)) {
      dict.set(m.id, m);
    }
  }
  return dict;
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
    .replace(/^qwen\//, "alibaba/")
    .replace(/^moonshotai\//, "moonshotai/");
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
  map.off = off ?? (mandatory ? null : null);
  if (minimal) map.minimal = minimal;
  if (low) map.low = low;
  if (medium) map.medium = medium;
  if (high) map.high = high;
  if (xhigh) map.xhigh = xhigh;
  if (max) map.max = max;
  return Object.keys(map).length > 1 || map.off !== undefined ? map : undefined;
}

function optionsToThinkingLevelMap(options: ModelsDevReasoningOption[] | undefined, reasoning?: boolean): ThinkingLevelMap | undefined {
  if (!reasoning) return undefined;
  const effort = options?.find((o) => o?.type === "effort" && Array.isArray(o.values));
  if (!effort?.values?.length) return undefined;
  return mapEffortValuesToThinkingLevelMap(effort.values);
}

function rawToLikeModel(
  id: string,
  raw: ModelsDevRawModel,
  sourceLabel: string,
  rank: number,
): ModelsDevSource {
  const actualId = raw.id || id;
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
  if (Array.isArray(raw.modalities?.input)) model.input = [...raw.modalities.input];
  const key = normalizeId(actualId);
  return { key, bare: bareId(actualId), model, reasoningOptions, rank };
}

function addSource(map: Map<string, ModelsDevSource[]>, key: string, src: ModelsDevSource): void {
  const list = map.get(key) ?? [];
  list.push(src);
  map.set(key, list);
}

function sourceScore(src: ModelsDevSource): number {
  let s = src.rank;
  if (src.model.thinkingLevelMap) s += 100 + scoreMap(src.model.thinkingLevelMap);
  if (src.model.reasoning) s += 20;
  if (src.model.contextWindow) s += 5;
  if (src.model.maxTokens) s += 5;
  return s;
}

function pickBest(sources: ModelsDevSource[] | undefined): ModelsDevSource | undefined {
  if (!sources?.length) return undefined;
  return [...sources].sort((a, b) => sourceScore(b) - sourceScore(a))[0];
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
      addSource(apiExact, src.key, src);
      addSource(apiBare, src.bare, src);
    }
  }

  // Add canonical model records with a high rank, enriched with the best
  // matching API reasoning map when available.
  for (const [id, raw] of Object.entries(modelsJson ?? {})) {
    const src = rawToLikeModel(id, raw, "models.dev", 1000);
    const optionSrc = pickBest(apiExact.get(src.key)) ?? pickBest(apiBare.get(src.bare));
    if (!src.model.thinkingLevelMap && optionSrc?.model.thinkingLevelMap) {
      src.model.thinkingLevelMap = { ...optionSrc.model.thinkingLevelMap };
    }
    if (src.model.reasoning === undefined && optionSrc?.model.reasoning !== undefined) {
      src.model.reasoning = optionSrc.model.reasoning;
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

export function lookupModelsDevModel(index: ModelsDevIndex | undefined, id: string): EnrichSource | undefined {
  if (!index) return undefined;
  for (const key of candidateKeys(id)) {
    const exact = pickBest(index.exact.get(key));
    if (exact) return exact.model;
  }
  const bare = bareId(id);
  return pickBest(index.bare.get(bare))?.model;
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
  if (m.input === undefined && src.input) {
    m.input = [...src.input];
    patches.push("input");
  }
  if (m.name === undefined && src.name) {
    m.name = src.name;
    patches.push("name");
  }
  return patches;
}

/**
 * Prefer models.dev if it has a match; otherwise fall back to pi built-ins.
 * Returns [patched field names, source model].
 */
export function enrichModel(
  m: LikeModel,
  ctx: EnrichContext | Map<string, LikeModel>,
): [string[], EnrichSource | undefined] {
  const enrichCtx: EnrichContext = ctx instanceof Map ? { builtIn: ctx } : ctx;

  const modelsDevSrc = lookupModelsDevModel(enrichCtx.modelsDev, m.id);
  if (modelsDevSrc) {
    return [applyModelPatch(m, modelsDevSrc), modelsDevSrc];
  }

  const src = enrichCtx.builtIn.get(m.id) as EnrichSource | undefined;
  if (!src) return [[], undefined];
  return [applyModelPatch(m, src), { ...src, sourceLabel: src.provider ? `built-in/${src.provider}` : "built-in" }];
}
