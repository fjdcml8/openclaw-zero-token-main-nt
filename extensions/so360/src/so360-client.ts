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

// 360 搜索主端点：国内直连、免 key，返回 200 无需重定向，中文分词正常。
// 搜狗(www.sogou.com)已弹字符点选验证码封自动化请求，360 实测稳定可用。
// 结果里真实 URL 直接放在 <a data-mdurl="..."> 属性，无需走 /link 反跳。
const SO360_SEARCH_ENDPOINT = "https://www.so.com/s";
const DEFAULT_TIMEOUT_SECONDS = 20;

const SO360_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

type So360Result = {
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
  // 360 摘要通常在 <p class="res-desc"> 里，前面带 <span class="gray g-c-gray">日期</span> 前缀。
  const pMatch = /<p\b[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(blockHtml);
  if (!pMatch) {
    return "";
  }
  const text = pMatch[1].replace(
    /<span\b[^>]*class="[^"]*gray[^"]*"[^>]*>[\s\S]*?<\/span>/i,
    "",
  );
  return decodeHtmlEntities(stripHtml(text));
}

function extractUrl(anchorAttrs: string): string {
  // 360 真实地址在 data-mdurl 属性；回退到 href（多为 /link 反跳，相对路径拼站前缀）。
  const dataMdurl = /data-mdurl="([^"]*)"/i.exec(anchorAttrs);
  if (dataMdurl?.[1]) {
    return decodeHtmlEntities(dataMdurl[1]);
  }
  const href = /href="([^"]*)"/i.exec(anchorAttrs);
  if (href?.[1]) {
    const raw = decodeHtmlEntities(href[1]);
    if (raw.startsWith("/")) {
      return `https://www.so.com${raw}`;
    }
    return raw;
  }
  return "";
}

/** Parse 360 organic results: <li class="res-list"> blocks with <h3 class="res-title"><a data-mdurl=...>Title</a></h3>. */
function parseSo360Html(html: string): So360Result[] {
  const results: So360Result[] = [];
  // 按 res-list 切块：chunks[0] 是前导内容，其后每块以 `<li class="res-list` 开头、延伸到下一个块。
  const chunks = html.split(/<li class="res-list/i);

  for (let i = 1; i < chunks.length; i++) {
    const block = chunks[i];
    // 只认 res-title 标题块；"其他人还搜了" 等侧边块是 <h3 class="title">，会跳过。
    const titleMatch =
      /<h3\b[^>]*class="[^"]*res-title[^"]*"[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(block);
    if (!titleMatch) {
      continue;
    }
    const title = decodeHtmlEntities(stripHtml(titleMatch[2]));
    const url = extractUrl(titleMatch[1]);

    if (title && url) {
      results.push({ title, url, snippet: extractSnippet(block) });
    }
  }

  return results;
}

function isBotChallenge(html: string): boolean {
  // 有 res-title 结果块说明是正常结果页；否则可能是反爬/验证码拦截。
  if (/<h3\b[^>]*class="[^"]*res-title[^"]*"/i.test(html)) {
    return false;
  }
  return /验证码|captcha|antispider|安全验证|unusual traffic|seccode/i.test(html);
}

/** Run the actual HTTP search, returning parsed results. */
async function searchEndpoint(params: {
  url: string;
  query: string;
  count: number;
  timeoutSeconds: number;
}): Promise<So360Result[]> {
  const url = new URL(params.url);
  url.searchParams.set("q", params.query);

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
          "Accept-Encoding": "identity",
          Referer: "https://www.so.com/",
        },
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
        throw new Error(`360 search error (${response.status}): ${detail || response.statusText}`);
      }
      const html = await response.text();
      if (isBotChallenge(html)) {
        throw new Error("360 search returned a bot-detection challenge.");
      }
      return parseSo360Html(html).slice(0, params.count);
    },
  );
}

export async function runSo360Search(params: {
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
    JSON.stringify({ provider: "so360", query: params.query, count }),
  );
  const cached = readCache(SO360_SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const startedAt = Date.now();

  let results: So360Result[] = [];
  try {
    results = await searchEndpoint({
      url: SO360_SEARCH_ENDPOINT,
      query: params.query,
      count,
      timeoutSeconds,
    });
  } catch (error) {
    throw new Error(
      `360 search failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const payload = {
    query: params.query,
    provider: "so360",
    count: results.length,
    tookMs: Date.now() - startedAt,
    endpoint: SO360_SEARCH_ENDPOINT,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "so360",
      wrapped: true,
    },
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
      siteName: resolveSiteName(result.url) || undefined,
    })),
  } satisfies Record<string, unknown>;

  writeCache(SO360_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
  return payload;
}

export const __testing = {
  decodeHtmlEntities,
  extractSnippet,
  extractUrl,
  isBotChallenge,
  parseSo360Html,
};
