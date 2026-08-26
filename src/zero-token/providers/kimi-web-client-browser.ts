import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { getHeadersWithAuth } from "../../../extensions/browser/src/browser/cdp.helpers.js";
import {
  launchOpenClawChrome,
  stopOpenClawChrome,
  getChromeWebSocketUrl,
  type RunningChrome,
} from "../../../extensions/browser/src/browser/chrome.js";
import {
  resolveBrowserConfig,
  resolveProfile,
} from "../../../extensions/browser/src/browser/config.js";
import { loadConfig } from "../../config/io.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";

export interface KimiWebClientOptions {
  cookie?: string;
  accessToken?: string;
  refreshToken?: string;
  userAgent?: string;
}

/**
 * Kimi Web Client using CDP attach.
 *
 * Kimi's API requires browser session cookies for auth — the browser must have
 * an active kimi.com session. Calls are made via page.evaluate so the browser's
 * cookie jar and origin context are sent automatically.
 */
export class KimiWebClientBrowser {
  private cookie: string;
  private accessToken: string;
  private refreshToken: string;
  private userAgent: string;
  private baseUrl = "https://www.kimi.com";
  private browser: BrowserContext | null = null;
  private page: Page | null = null;
  private running: RunningChrome | null = null;

  constructor(options: KimiWebClientOptions | string) {
    if (typeof options === "string") {
      try {
        const parsed = JSON.parse(options) as KimiWebClientOptions;
        this.cookie = parsed.cookie || "";
        this.accessToken = parsed.accessToken || "";
        this.refreshToken = parsed.refreshToken || "";
        this.userAgent = parsed.userAgent || "Mozilla/5.0";
      } catch {
        this.cookie = options;
        this.accessToken = "";
        this.refreshToken = "";
        this.userAgent = "Mozilla/5.0";
      }
    } else {
      this.cookie = options.cookie || "";
      this.accessToken = options.accessToken || "";
      this.refreshToken = options.refreshToken || "";
      this.userAgent = options.userAgent || "Mozilla/5.0";
    }
  }

  private async ensureBrowser() {
    if (this.browser && this.page) {
      // Verify the page is still loaded and responsive
      try {
        await this.page.evaluate(() => document.title);
        return { browser: this.browser, page: this.page };
      } catch {
        // Page is gone, re-init
        this.browser = null;
        this.page = null;
      }
    }

    const rootConfig = loadConfig();
    const browserConfig = resolveBrowserConfig(rootConfig.browser, rootConfig);
    const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
    if (!profile) {
      throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
    }

    if (browserConfig.attachOnly) {
      let wsUrl: string | null = null;
      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(profile.cdpUrl, 2000);
        if (wsUrl) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!wsUrl) {
        throw new Error(
          `Failed to connect to Chrome at ${profile.cdpUrl}. Make sure Chrome is running in debug mode (./start-chrome-debug.sh)`,
        );
      }

      this.browser = (
        await chromium.connectOverCDP(wsUrl, { headers: getHeadersWithAuth(wsUrl) })
      ).contexts()[0]!;

      const pages = this.browser.pages();
      let kimiPage = pages.find(
        (p) => p.url().includes("kimi.com") || p.url().includes("moonshot.cn"),
      );
      if (kimiPage) {
        this.page = kimiPage;
      } else {
        this.page = await this.browser.newPage();
        await this.page.goto(`${this.baseUrl}/`, { waitUntil: "domcontentloaded" });
      }
    } else {
      this.running = await launchOpenClawChrome(browserConfig, profile);
      const cdpUrl = `http://127.0.0.1:${this.running.cdpPort}`;
      let wsUrl: string | null = null;
      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
        if (wsUrl) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!wsUrl) {
        throw new Error(`Failed to resolve Chrome WebSocket URL from ${cdpUrl}`);
      }

      this.browser = (
        await chromium.connectOverCDP(wsUrl, { headers: getHeadersWithAuth(wsUrl) })
      ).contexts()[0]!;
      this.page = this.browser.pages()[0] || (await this.browser.newPage());
    }

    // Inject saved cookies. For kimi-auth specifically, only inject if the
    // browser does NOT already have one — the browser's own session cookie
    // is authoritative and should NOT be overwritten.
    if (this.cookie.trim()) {
      const pageUrl = this.page?.url() ?? this.baseUrl;
      const domain = pageUrl.includes("moonshot.cn") ? ".moonshot.cn" : ".kimi.com";

      // Check which cookies the browser already has
      let existingCookieNames: Set<string> = new Set();
      try {
        const existingCookies = await this.browser.cookies([domain]);
        existingCookieNames = new Set(existingCookies.map((c) => c.name));
      } catch {
        // If we can't read existing cookies, proceed with injection
      }

      const rawCookies = this.cookie.split(";").map((c) => {
        const [name, ...valueParts] = c.trim().split("=");
        const nameStr = name?.trim() ?? "";
        const valueStr = valueParts.join("=").trim();
        if (!nameStr) return null;
        // Only skip kimi-auth if browser already has one
        if (nameStr === "kimi-auth" && existingCookieNames.has("kimi-auth")) {
          return null;
        }
        const cookie: {
          name: string;
          value: string;
          domain: string;
          path: string;
          secure?: boolean;
        } = {
          name: nameStr,
          value: valueStr,
          domain,
          path: "/",
        };
        if (nameStr.startsWith("__Secure-") || nameStr.startsWith("__Host-")) {
          cookie.secure = true;
        }
        return cookie;
      });
      const cookies = rawCookies.filter((c): c is NonNullable<typeof c> => c !== null);
      if (cookies.length > 0) {
        try {
          await this.browser.addCookies(cookies);
        } catch (err) {
          console.warn(
            `[Kimi Web] addCookies failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Inject saved access_token into localStorage so the API call can find it.
    // The browser's localStorage may be empty if the session expired or a
    // different browser profile is used.
    if (this.accessToken && this.page) {
      try {
        await this.page.evaluate(
          (token: string) => {
            if (!localStorage.getItem("access_token")) {
              localStorage.setItem("access_token", token);
            }
          },
          this.accessToken,
        );
      } catch (err) {
        console.warn(
          `[Kimi Web] localStorage injection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (this.refreshToken && this.page) {
      try {
        await this.page.evaluate(
          (token: string) => {
            if (!localStorage.getItem("refresh_token")) {
              localStorage.setItem("refresh_token", token);
            }
          },
          this.refreshToken,
        );
      } catch {
        // refresh_token is optional; ignore failures
      }
    }

    return { browser: this.browser, page: this.page };
  }

  async init() {
    await this.ensureBrowser();
  }

  async chatCompletions(params: {
    conversationId?: string;
    message: string;
    model: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    const { browser, page } = await this.ensureBrowser();

    // Ensure page is on kimi.com for proper cookie context
    if (!page.url().includes("kimi.com") && !page.url().includes("moonshot.cn")) {
      await page.goto(`${this.baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    }

    // Safety: re-inject access_token into localStorage now that we are confirmed
    // on the kimi.com origin. The ensureBrowser injection may have landed on a
    // different origin (e.g. about:blank) and been ineffective.
    if (this.accessToken) {
      try {
        await page.evaluate(
          (token: string) => {
            if (!localStorage.getItem("access_token")) {
              localStorage.setItem("access_token", token);
            }
          },
          this.accessToken,
        );
      } catch {
        // Ignore — the page.evaluate call below has its own fallback
      }
    }
    if (this.refreshToken) {
      try {
        await page.evaluate(
          (token: string) => {
            if (!localStorage.getItem("refresh_token")) {
              localStorage.setItem("refresh_token", token);
            }
          },
          this.refreshToken,
        );
      } catch {
        // refresh_token is optional
      }
    }

    // Verify browser has KIMI session
    const kimiCookies = await browser.cookies([this.baseUrl]);
    const hasKimiAuth = kimiCookies.some((c) => c.name === "kimi-auth");
    console.log(`[Kimi Web] Auth check: kimi-auth=${hasKimiAuth}`);
    if (!hasKimiAuth) {
      throw new Error("Kimi: 未登录。请在 Chrome 调试浏览器中打开 https://www.kimi.com 并登录后重试。");
    }

    const scenario = params.model.includes("search")
      ? "SCENARIO_SEARCH"
      : params.model.includes("research")
        ? "SCENARIO_RESEARCH"
        : params.model.includes("k1")
          ? "SCENARIO_K1"
          : "SCENARIO_K2";

    // Run the API call INSIDE the browser page so cookies & localStorage are available.
    // Kimi uses access_token from localStorage (NOT the kimi-auth cookie) for API auth.
    // Pass the saved accessToken as fallback in case localStorage doesn't have it.
    console.log(`[Kimi Web] Calling API via page.evaluate...`);
    const savedAccessToken = this.accessToken;
    const result = await page.evaluate(
      async ({ baseUrl, message, scenario, convId, savedToken }: {
        baseUrl: string; message: string; scenario: string; convId?: string; savedToken: string;
      }) => {
        // Get the real access token from localStorage, fall back to saved token
        const accessToken = localStorage.getItem("access_token") || savedToken;
        if (!accessToken) return { ok: false as const, error: "No access_token in localStorage. Please log in to kimi.com." };
        const req: Record<string, unknown> = {
          scenario,
          message: {
            role: "user" as const,
            blocks: [{ message_id: "", text: { content: message } }],
            scenario,
          },
          options: { thinking: false },
        };
        if (convId) req.chat_id = convId;

        const enc = new TextEncoder().encode(JSON.stringify(req));
        const buf = new ArrayBuffer(5 + enc.byteLength);
        const dv = new DataView(buf);
        dv.setUint8(0, 0x00);
        dv.setUint32(1, enc.byteLength, false);
        new Uint8Array(buf, 5).set(enc);

        const res = await fetch(`${baseUrl}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/connect+json",
            "Connect-Protocol-Version": "1",
            "X-Language": "zh-CN",
            "X-Msh-Platform": "web",
            Authorization: `Bearer ${accessToken}`,
          },
          body: buf,
          credentials: "include",
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return { ok: false as const, error: `HTTP ${res.status}: ${text.slice(0, 400)}` };
        }

        if (!res.body) return { ok: false as const, error: "Empty response body" };

        // Stream-read binary frames to avoid hang
        const reader = res.body.getReader();
        let conv: string | undefined;
        const texts: string[] = [];
        let leftover = new Uint8Array(0);

        while (true) {
          const { value, done: rd } = await reader.read();

          // Merge chunks
          const data = value ? (() => {
            const m = new Uint8Array(leftover.length + value.length);
            m.set(leftover); m.set(value, leftover.length);
            return m;
          })() : leftover;

          let o = 0;
          while (o + 5 <= data.length) {
            const flen = new DataView(data.buffer, data.byteOffset + o + 1, 4).getUint32(0, false);
            if (o + 5 + flen > data.length) break;
            const chunk = new TextDecoder().decode(data.slice(o + 5, o + 5 + flen));
            try {
              const obj = JSON.parse(chunk);
              if (obj.error) {
                return {
                  ok: false as const,
                  error: obj.error.message || obj.error.code || JSON.stringify(obj.error).slice(0, 200),
                };
              }
              // KIMI response structure: chat.id is the conversation ID, message.id is the last message
              const chat = obj.chat as Record<string, unknown> | undefined;
              if (!conv && typeof chat?.id === "string") conv = chat.id;
              if (!conv && typeof obj.message?.id === "string") conv = (obj.message as Record<string, unknown>).id as string;
              const op = (obj.op as string) || "";
              if (obj.block?.text?.content && (op === "append" || op === "set")) {
                texts.push(obj.block.text.content as string);
              } else if (obj.text?.content && (op === "append" || op === "set")) {
                texts.push(obj.text.content as string);
              }
              if ("done" in obj) return { ok: true as const, text: texts.join(""), conversationId: conv };
            } catch { /* skip non-JSON */ }
            o += 5 + flen;
          }
          leftover = data.slice(o);
          if (rd) break;
        }
        return { ok: true as const, text: texts.join(""), conversationId: conv };
      },
      { baseUrl: this.baseUrl, message: params.message, scenario, convId: params.conversationId, savedToken: savedAccessToken },
    );

    if (!result.ok) {
      throw new Error(`Kimi API 错误: ${result.error}`);
    }

    // Debug: log whether we got any text
    if (!result.text || result.text.length === 0) {
      console.warn(`[Kimi Web] WARNING: empty response from KIMI. convId=${result.conversationId || "null"}. The API may have rejected the request silently or the auth token may be expired.`);
    }
    console.log(`[Kimi Web] Done: textLen=${result.text.length} convId=${result.conversationId || "null"}`);

    const escaped = JSON.stringify(result.text);
    // sessionId: use JSON null (not string "null") when no conv ID
    const convId = result.conversationId
      ? `"${String(result.conversationId).replace(/"/g, '\\"')}"`
      : "null";
    const sse = `data: {"text":${escaped},"sessionId":${convId}}\n\ndata: [DONE]\n\n`;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
  }

  async close() {
    if (this.running) {
      await stopOpenClawChrome(this.running);
      this.running = null;
    }
    this.browser = null;
    this.page = null;
  }

  async discoverModels(): Promise<ModelDefinitionConfig[]> {
    return [
      {
        id: "moonshot-v1-32k",
        name: "Moonshot v1 32K",
        api: "kimi-web",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      },
    ] as ModelDefinitionConfig[];
  }
}
