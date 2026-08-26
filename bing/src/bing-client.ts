import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_SEARCH_COUNT,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveSearchCount,
  resolveSiteName,
  resolveTimeoutSeconds,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  resolveBingRegion,
  resolveBingSafeSearch,
  type BingSafeSearch,
} from "./config.js";

// 主端点直接用 cn.bing.com：国内直达、返回 200 无需重定向。
// 注意不要用 www.bing.com —— 它会 302 到 cn.bing.com，而 OpenClaw 的 SSRF
// 守卫以 manual 模式处理重定向时会因缺失 Location 头直接抛错。
const BING_SEARCH_ENDPOINT = "https://cn.bing.com/search";
const DEFAULT_TIMEOUT_SECONDS = 20;
const BING_SAFE_SEARCH_PARAM: Record<BingSafeSearch, string> = {
  strict: "strict",
  moderate: "moderate",
  off: "off",
};

const BING_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

type BingResult = {
  title: string;
  url: string;
  snippet: string;
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, " ")
    .replace(/&#0183;/g, "·")
    .replace(/&#183;/g, "·")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "--")
    .replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Decode Bing's /ck/a redirect wrapper URLs back to the target URL. */
function decodeBingUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (
      (parsed.hostname === "www.bing.com" || parsed.hostname === "cn.bing.com") &&
      parsed.pathname.startsWith("/ck/a")
    ) {
      const encoded = parsed.searchParams.get("u");
      if (encoded) {
        const decoded = Buffer.from(encoded, "base64url").toString("utf8");
        if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
          return decoded;
        }
      }
    }
  } catch {
    // Keep the original value when Bing already returns a direct link.
  }
  return rawUrl;
}

function extractSnippet(blockHtml: string): string {
  // Bing 摘要通常在 <p class="b_lineclamp..."> 或 caption 里的第一个 <p>。
  const captionMatch = /<div class="b_caption"[\s\S]*?<\/div>/i.exec(blockHtml)?.[0] ?? "";
  const scoped = captionMatch || blockHtml;
  const pMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(scoped);
  return pMatch ? decodeHtmlEntities(stripHtml(pMatch[1])) : "";
}

/** Parse Bing organic results: <li class="b_algo"> blocks with <h2><a href=...>Title</a></h2>. */
function parseBingHtml(html: string): BingResult[] {
  const results: BingResult[] = [];
  const blockRegex = /<li class="b_algo"[\s\S]*?<\/li>/gi;

  for (const match of html.matchAll(blockRegex)) {
    const block = match[0];
    const titleLinkMatch = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
    if (!titleLinkMatch) {
      continue;
    }
    const titleSegment = titleLinkMatch[1];
    const hrefMatch = /<a\b[^>]*\bhref="([^"]*)"[^>]*>/i.exec(titleSegment);
    const title = decodeHtmlEntities(stripHtml(titleSegment));
    const rawUrl = hrefMatch?.[1] ?? "";
    const url = decodeBingUrl(decodeHtmlEntities(rawUrl));

    if (title && url) {
      results.push({ title, url, snippet: extractSnippet(block) });
    }
  }

  return results;
}

function isBotChallenge(html: string): boolean {
  // b_algo 结果存在说明是正常搜索结果页；否则可能被反爬/验证码拦截。
  if (/<li class="b_algo"/i.test(html)) {
    return false;
  }
  return /captcha|verify|unusual traffic|请输入验证码|验证码/i.test(html);
}

/** Run the actual HTTP search against a single endpoint, returning parsed results. */
async function searchEndpoint(params: {
  url: string;
  query: string;
  count: number;
  region?: string;
  safeSearch: BingSafeSearch;
  timeoutSeconds: number;
}): Promise<BingResult[]> {
  const url = new URL(params.url);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(Math.min(10, params.count)));
  if (params.region) {
    url.searchParams.set("mkt", params.region);
  }
  url.searchParams.set("adlt", BING_SAFE_SEARCH_PARAM[params.safeSearch]);

  return await withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          // 必须强制 identity 编码：在 OpenClaw 的 pinned-DNS 守卫下，Bing 返回的
          // 压缩响应不会被自动解压（且无 content-encoding 头），会拿到二进制乱码。
          "Accept-Encoding": "identity",
        },
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
        throw new Error(`Bing search error (${response.status}): ${detail || response.statusText}`);
      }
      const html = await response.text();
      if (isBotChallenge(html)) {
        throw new Error("Bing returned a bot-detection challenge.");
      }
      return parseBingHtml(html).slice(0, params.count);
    },
  );
}

export async function runBingSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  region?: string;
  safeSearch?: BingSafeSearch;
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
}): Promise<Record<string, unknown>> {
  const count = resolveSearchCount(params.count, DEFAULT_SEARCH_COUNT);
  const region = params.region ?? resolveBingRegion(params.config);
  const safeSearch =
    params.safeSearch === "strict" || params.safeSearch === "moderate" || params.safeSearch === "off"
      ? params.safeSearch
      : resolveBingSafeSearch(params.config);
  const timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  const cacheTtlMs = resolveCacheTtlMs(params.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: "bing",
      query: params.query,
      count,
      region: region ?? "",
      safeSearch,
    }),
  );
  const cached = readCache(BING_SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const startedAt = Date.now();

  // 主端点 www.bing.com（自动重定向到 cn.bing.com）；失败时回退到 cn.bing.com 直连。
  let results: BingResult[] = [];
  let endpointUsed = BING_SEARCH_ENDPOINT;
  try {
    results = await searchEndpoint({
      url: BING_SEARCH_ENDPOINT,
      query: params.query,
      count,
      region,
      safeSearch,
      timeoutSeconds,
    });
  } catch {
    try {
      results = await searchEndpoint({
        url: BING_CN_ENDPOINT,
        query: params.query,
        count,
        region,
        safeSearch,
        timeoutSeconds,
      });
      endpointUsed = BING_CN_ENDPOINT;
    } catch (error) {
      throw new Error(
        `Bing search failed on both endpoints: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const payload = {
    query: params.query,
    provider: "bing",
    count: results.length,
    tookMs: Date.now() - startedAt,
    endpoint: endpointUsed,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "bing",
      wrapped: true,
    },
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
      siteName: resolveSiteName(result.url) || undefined,
    })),
  } satisfies Record<string, unknown>;

  writeCache(BING_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
  return payload;
}

export const __testing = {
  decodeBingUrl,
  decodeHtmlEntities,
  extractSnippet,
  isBotChallenge,
  parseBingHtml,
};
