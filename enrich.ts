/**
 * Shared logic: match pi built-in models by id and fill missing fields
 * on custom provider models. Used by /add-provider, /edit-provider, /sync-model.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface LikeModel {
  id: string;
  provider?: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null> | null;
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

/** Completeness score for thinkingLevelMap; prefers maps that define max. */
export function scoreMap(map?: Record<string, string | null> | null): number {
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
    if (!m?.id || !m.thinkingLevelMap) continue;
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

/**
 * Fill missing fields on one model from the built-in match.
 * Only touches unset fields (idempotent).
 * Returns [patched field names, source model].
 */
export function enrichModel(
  m: LikeModel,
  dict: Map<string, LikeModel>,
): [string[], LikeModel | undefined] {
  const src = dict.get(m.id);
  if (!src) return [[], undefined];
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
  return [patches, src];
}
