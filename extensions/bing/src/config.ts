import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export const DEFAULT_BING_SAFE_SEARCH = "moderate";

export type BingSafeSearch = "strict" | "moderate" | "off";

type BingPluginConfig = {
  webSearch?: {
    region?: string;
    safeSearch?: string;
  };
};

export function resolveBingWebSearchConfig(
  config?: OpenClawConfig,
): BingPluginConfig["webSearch"] | undefined {
  const pluginConfig = config?.plugins?.entries?.bing?.config as BingPluginConfig | undefined;
  const webSearch = pluginConfig?.webSearch;
  if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) {
    return webSearch;
  }
  return undefined;
}

export function resolveBingRegion(config?: OpenClawConfig): string | undefined {
  const region = resolveBingWebSearchConfig(config)?.region;
  if (typeof region !== "string") {
    return undefined;
  }
  const trimmed = region.trim();
  return trimmed || undefined;
}

export function resolveBingSafeSearch(config?: OpenClawConfig): BingSafeSearch {
  const safeSearch = resolveBingWebSearchConfig(config)?.safeSearch;
  const normalized = typeof safeSearch === "string" ? safeSearch.trim().toLowerCase() : "";
  if (normalized === "strict" || normalized === "off") {
    return normalized;
  }
  return DEFAULT_BING_SAFE_SEARCH;
}
