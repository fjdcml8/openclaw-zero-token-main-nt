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

// 搜狗主端点：国内直连、免 key、返回 200 无需重定向，中文结果比 cn.bing.com 可靠
// (cn.bing.com 对含「大跌/下跌」等词的中文查询会被分词崩成匹配单字，实测返回无关结果)。
const SOGOU_SEARCH_ENDPOINT = "https://www.sogou.com/web";
const DEFAULT_TIMEOUT_SECONDS = 20;

const SOGOU_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

type SogouResult = {
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

function extractSnippet(blockHtml: string): string {
  // 搜狗摘要通常在 <p class="star-wiki ..."> 里（带 <em> 高亮和 <!--red_beg--> 标记）。
  const pMatch = /<p\b[^>]*class="[^"]*star-wiki[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(blockHtml);
  return pMatch ? decodeHtmlEntities(stripHtml(pMatch[1])) : "";
}

/** Parse Sogou organic results: <div class="vrwrap"> blocks with <h3 class="vr-title"><a href=...>Title</a></h3>. */
function parseSogouHtml(html: string): SogouResult[] {
  const results: SogouResult[] = [];
  // 按 vrwrap 切块：chunks[0] 是前导内容，其后每块以 `<div class="vrwrap">` 开头、延伸到下一个块。
  const chunks = html.split(/<div class="vrwrap"/i);

  for (let i = 1; i < chunks.length; i++) {
    const block = chunks[i];
    const titleLinkMatch = /<h3\b[^>]*>[\s\S]*?<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!titleLinkMatch) {
      continue;
    }
    const rawUrl = decodeHtmlEntities(titleLinkMatch[1]);
    const title = decodeHtmlEntities(stripHtml(titleLinkMatch[2]));
    // 搜狗命中标题含 <em>/<!--red_beg--> 高亮标记，stripHtml 已剔除。
    let url = rawUrl;
    // 搜狗结果多为相对 /link?url=... 跳转地址，需拼站前缀。
    if (url.startsWith("/")) {
      url = `https://www.sogou.com${url}`;
    }

    if (title && url) {
      results.push({ title, url, snippet: extractSnippet(block) });
    }
  }

  return results;
}

function isBotChallenge(html: string): boolean {
  // 有 vrwrap 结果块说明是正常结果页；否则可能是反爬/验证码拦截。
  if (/<div class="vrwrap"/i.test(html)) {
    return false;
  }
  return /captcha|verify|unusual traffic|antispider|seccode|请输入验证码|验证码/i.test(html);
}

/** Run the actual HTTP search, returning parsed results. */
async function searchEndpoint(params: {
  url: string;
  query: string;
  count: number;
  timeoutSeconds: number;
}): Promise<SogouResult[]> {
  const url = new URL(params.url);
  url.searchParams.set("query", params.query);
  url.searchParams.set("num", String(Math.min(10, params.count)));

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
          // 强制 identity 编码：与 bing 插件同一守卫环境，压缩响应不会被自动解压，
          // 显式声明 identity 可拿到明文 HTML。
          "Accept-Encoding": "identity",
        },
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
        throw new Error(`Sogou search error (${response.status}): ${detail || response.statusText}`);
      }
      const html = await response.text();
      if (isBotChallenge(html)) {
        throw new Error("Sogou returned a bot-detection challenge.");
      }
      return parseSogouHtml(html).slice(0, params.count);
    },
  );
}

export async function runSogouSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
}): Promise<Record<string, unknown>> {
  const count = resolveSearchCount(params.count, DEFAULT_SEARCH_COUNT);
  const timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  const cacheTtlMs = resolveCacheTtlMs(params.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({ provider: "sogou", query: params.query, count }),
  );
  const cached = readCache(SOGOU_SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const startedAt = Date.now();

  let results: SogouResult[] = [];
  try {
    results = await searchEndpoint({
      url: SOGOU_SEARCH_ENDPOINT,
      query: params.query,
      count,
      timeoutSeconds,
    });
  } catch (error) {
    throw new Error(
      `Sogou search failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const payload = {
    query: params.query,
    provider: "sogou",
    count: results.length,
    tookMs: Date.now() - startedAt,
    endpoint: SOGOU_SEARCH_ENDPOINT,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "sogou",
      wrapped: true,
    },
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
      siteName: resolveSiteName(result.url) || undefined,
    })),
  } satisfies Record<string, unknown>;

  writeCache(SOGOU_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
  return payload;
}

export const __testing = {
  decodeHtmlEntities,
  extractSnippet,
  isBotChallenge,
  parseSogouHtml,
};
