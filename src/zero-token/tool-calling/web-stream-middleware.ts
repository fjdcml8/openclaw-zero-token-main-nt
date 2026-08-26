/**
 * Web Stream Middleware — unified input/output processing for all web models.
 *
 * Input:  extract last user message → strip metadata → inject tool prompt
 * Output: parse tool calls from response → emit ToolCall events
 *
 * This middleware replaces the per-stream prompt manipulation that was
 * previously duplicated across 13 stream files.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type TextContent,
  type ToolCall,
} from "@mariozechner/pi-ai";
import { stripInboundMeta } from "../streams/strip-inbound-meta.js";
import { extractToolCalls, normalizeFullwidthTagDelimiters } from "./web-tool-parser.js";
import { shouldInjectToolPrompt, getToolPrompt } from "./web-tool-prompt.js";

/**
 * Strip ```tool_json``` fenced blocks from text, returning only the
 * human-readable prefix/suffix that isn't part of a tool call.
 * Used so the model's natural-language lead-in ("Let me check…") still
 * renders in the UI, while the JSON blocks are intercepted for execution.
 */
function stripToolJsonBlocks(text: string): string {
  let out = text
    .replace(/```tool_json[\s\S]*?```/g, "")
    .replace(/```json[\s\S]*?```/g, "");
  // DeepSeek emits tool-call tags with full-width pipe delimiters and an
  // optional model prefix (<DSML｜｜tool_call>, <｜ｐｅｆ｜tool_call>, <｜｜tool_call>).
  // Normalize to ASCII so the strip regexes below match. Shared with the parser
  // so the extraction and the display-text cleanup always agree.
  if (out.includes("｜")) {
    out = normalizeFullwidthTagDelimiters(out);
  }
  // Strip XML tool-call blocks and any stray open/close tags (lazy match so the
  // whole block is removed; an unterminated first call is consumed by the next
  // block's closing tag). Also drop stray <parameter> tags the vision model
  // appends after raw JSON args — they are structural, not visible text.
  return out
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call\b[^>]*>/g, "")
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls>/g, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/g, "")
    .replace(/<\/?(?:tool_call|tool_calls|invoke|parameter)\b[^>]*>/g, "")
    .trim();
}

/**
 * Quick keyword check: does this message likely need tool use?
 * Only inject tool prompt when keywords suggest a tool action,
 * keeping normal chat messages short to reduce ban risk.
 */
function needsToolInjection(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = [
    // File operations
    "文件",
    "file",
    "read",
    "write",
    "创建",
    "写入",
    "读取",
    "打开",
    "保存",
    "桌面",
    "desktop",
    "目录",
    "directory",
    "folder",
    "文件夹",
    // Command execution
    "执行",
    "运行",
    "命令",
    "command",
    "run",
    "exec",
    "terminal",
    "终端",
    "shell",
    // Web operations
    "搜索",
    "search",
    "查找",
    "查询",
    "fetch",
    "抓取",
    "网页",
    "url",
    "http",
    "天气",
    "weather",
    "新闻",
    "news",
    // Message
    "发送",
    "send",
    "消息",
    "message",
    "通知",
    "notify",
    // CAD drawing (CAD 绘图标准模板：仅用户明确要求时触发)
    "cad",
    "绘图",
    "画图",
    "图纸",
    "dxf",
    // General tool hints
    "帮我",
    "help me",
    "查看",
    "check",
    "look",
    "看看",
    "show",
    "下载",
    "download",
    "安装",
    "install",
    "更新",
    "update",
  ];
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Wrap a web stream function with tool calling middleware.
 * - Rewrites context: cleans metadata, injects tool prompt on last user msg
 * - Preserves full message history when available (multi-turn context)
 * - Parses response: extracts tool_call JSON → emits ToolCall events
 */
export function wrapWithToolCalling(streamFn: StreamFn, api: string): StreamFn {
  // Shared helper: wrap a raw stream output for tool_json / tool_call extraction.
  // Used by both the normal path and the tool-result feedback path so the model
  // can emit more tool calls (e.g. retry a failed write) after seeing results.
  const wrapOutputForToolExtraction = (
    rawStreamOrPromise: ReturnType<StreamFn>,
    mdl: Parameters<StreamFn>[0],
  ) => {
    const wrappedStream = createAssistantMessageEventStream();

    const processEvents = async () => {
      try {
        const originalStream = await Promise.resolve(rawStreamOrPromise);
        const bufferedEvents: AssistantMessageEvent[] = [];
        let sawDone = false;

        for await (const event of originalStream) {
          if (event.type === "error") {
            // Forward error events immediately so they are not silently swallowed
            wrappedStream.push(event);
            sawDone = true; // treat error as terminal
            break;
          }
          if (event.type === "done") {
            sawDone = true;
            const finalMsg = event.message;
            let fullText = "";
            if (finalMsg && Array.isArray(finalMsg.content)) {
              const textParts: string[] = [];
              for (const part of finalMsg.content) {
                if (part.type === "text" && part.text) {
                  textParts.push(part.text);
                }
              }
              fullText = textParts.join("\n");
            }

            const toolCalls = extractToolCalls(fullText);

            if (toolCalls.length > 0) {
              const usage = finalMsg?.usage ?? {
                input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              };
              const baseTimestamp = Date.now();
              const nonToolText = stripToolJsonBlocks(fullText);
              let nextIndex = 0;
              const contentParts: (TextContent | ToolCall)[] = [];

              if (nonToolText) {
                contentParts.push({ type: "text", text: nonToolText });
                nextIndex++;
              }

              const toolCallParts: ToolCall[] = toolCalls.map((tc, idx) => ({
                type: "toolCall" as const,
                id: `web_tool_${baseTimestamp}_${idx}`,
                name: tc.tool,
                arguments: tc.parameters,
              }));

              for (const part of toolCallParts) {
                contentParts.push(part);
                const idx = nextIndex++;

                const partial: AssistantMessage = {
                  role: "assistant",
                  content: [...contentParts],
                  stopReason: "toolUse",
                  api: mdl.api,
                  provider: mdl.provider,
                  model: mdl.id,
                  usage,
                  timestamp: baseTimestamp,
                };

                wrappedStream.push({
                  type: "toolcall_start",
                  contentIndex: idx,
                  partial,
                });
                wrappedStream.push({
                  type: "toolcall_end",
                  contentIndex: idx,
                  toolCall: part,
                  partial,
                });
              }

              const finalMsg2: AssistantMessage = {
                role: "assistant",
                content: [...contentParts],
                stopReason: "toolUse",
                api: mdl.api,
                provider: mdl.provider,
                model: mdl.id,
                usage,
                timestamp: baseTimestamp,
              };
              wrappedStream.push({
                type: "done",
                reason: "toolUse",
                message: finalMsg2,
              });
            } else {
              for (const ev of bufferedEvents) {
                wrappedStream.push(ev);
              }
              wrappedStream.push(event);
            }
          } else {
            bufferedEvents.push(event);
          }
        }
        // If the stream ended without a terminal event (error/done),
        // flush buffered events so errors are not silently swallowed.
        if (!sawDone && bufferedEvents.length > 0) {
          for (const ev of bufferedEvents) {
            wrappedStream.push(ev);
          }
        }
      } catch (err) {
        wrappedStream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            api: mdl.api,
            provider: mdl.provider,
            model: mdl.id,
            usage: {
              input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        } as AssistantMessageEvent);
      } finally {
        wrappedStream.end();
      }
    };

    queueMicrotask(() => void processEvents());
    return wrappedStream;
  };

  return (model, context, options) => {
    // --- Input rewriting ---
    const messages = context.messages || [];

    // Vision-capable web models preserve `{type:"image"}` content blocks so the
    // web stream can upload them (e.g. deepseek-web vision). Document-capable web
    // models (e.g. deepseek-web v4-flash) preserve `{type:"document"}` blocks so
    // the web stream can upload them via ref_file_ids. Other models keep the
    // legacy string-collapse behavior.
    const modelInput = (model as { input?: unknown }).input;
    const supportsImages = Array.isArray(modelInput) && modelInput.includes("image");
    const supportsDocuments = Array.isArray(modelInput) && modelInput.includes("document");

    // hasAgentTools checks for native API tools (always false for web models).
    const hasAgentTools = (context.tools?.length ?? 0) > 0;

    // Check if this is a tool result feedback (agent loop returning tool execution results).
    // Aggregate ALL trailing toolResult messages: the agent executes every tool call in a
    // model message and emits one toolResult per call, so relaying only the last one would
    // hide earlier results (e.g. when the model reads several files in a single turn).
    const trailingToolResults: unknown[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "toolResult") {
        trailingToolResults.unshift(messages[i]);
      } else {
        break;
      }
    }
    if (trailingToolResults.length > 0) {
      const resultParts = trailingToolResults.map((tr) => {
        const t = tr as {
          toolName?: string;
          content?: Array<{ type: string; text?: string }>;
        };
        let resultText = "";
        if (Array.isArray(t.content)) {
          for (const part of t.content) {
            if (part.type === "text" && part.text) {
              resultText += part.text;
            }
          }
        }
        return `Tool ${t.toolName || "unknown"} returned: ${resultText}`;
      });
      // Format tool results as a user message for web models
      const feedbackPrompt = `${resultParts.join(
        "\n",
      )}\nPlease answer the original question based on these tool results.`;

      const feedbackContext = Object.assign({}, context, {
        messages: [{ role: "user" as const, content: feedbackPrompt }],
        tools: [] as typeof context.tools,
        systemPrompt: "",
      });
      console.log(`[WebStreamMiddleware] tool result feedback, len=${feedbackPrompt.length}, tools=${trailingToolResults.length}`);
      // Also wrap feedback responses for tool extraction.
      // The model may emit more tool calls (e.g. to retry a failed write).
      const shouldWrapFeedback = shouldInjectToolPrompt(api) || hasAgentTools;
      if (!shouldWrapFeedback) {
        return streamFn(model, feedbackContext, options);
      }
      return wrapOutputForToolExtraction(
        streamFn(model, feedbackContext, options),
        model,
      );
    }

    // Extract just the last user message (preserving image/document parts for
    // vision/document-capable models)
    let userMessage = "";
    let lastUserImages: Array<{ type: "image"; data: string; mimeType?: string }> = [];
    let lastUserDocuments: Array<{
      type: "document";
      data: string;
      mimeType?: string;
      fileName?: string;
    }> = [];
    const lastUserMsg = [...messages].toReversed().find((m) => m.role === "user");
    if (lastUserMsg) {
      if (typeof lastUserMsg.content === "string") {
        userMessage = lastUserMsg.content;
      } else if (Array.isArray(lastUserMsg.content)) {
        const parts = lastUserMsg.content as Array<{
          type: string;
          text?: string;
          data?: string;
          mimeType?: string;
          fileName?: string;
        }>;
        userMessage = parts
          .filter((p) => p.type === "text")
          .map((p) => p.text || "")
          .join("");
        if (supportsImages) {
          lastUserImages = parts.filter(
            (p): p is { type: "image"; data: string; mimeType?: string } =>
              p.type === "image" && Boolean(p.data),
          );
        }
        if (supportsDocuments) {
          lastUserDocuments = parts.filter(
            (
              p,
            ): p is {
              type: "document";
              data: string;
              mimeType?: string;
              fileName?: string;
            } => p.type === "document" && Boolean(p.data),
          );
        }
      }
    }

    // Strip OpenClaw metadata
    userMessage = stripInboundMeta(userMessage);

    if (!userMessage) {
      return streamFn(model, context, options);
    }

    // Only inject tool prompt when the message likely needs tool use.
    // This reduces ban risk by keeping most messages short and natural.
    // shouldInjectToolPrompt(api) alone determines whether the model can use
    // prompt-based tools (the normal path for browser-based web models).
    const injectTools = shouldInjectToolPrompt(api) && needsToolInjection(userMessage);

    // Build the processed prompt for the last user message
    const prompt = injectTools ? getToolPrompt(api) + userMessage : userMessage;

    console.log(
      `[WebStreamMiddleware] api=${api} injectTools=${injectTools} promptLen=${prompt.length} msgs=${messages.length}`,
    );

    // Preserve full conversation history so streams can build multi-turn context.
    // Only the last user message gets metadata stripping + optional tool prompt.
    // Single-message queries keep the original compact form.
    const hasHistory = messages.length > 1 ||
      (messages.length === 1 && messages[0]!.role !== "user");

    // Web models receive history as concatenated text — too many messages
    // overflows the practical input limit and causes empty responses.
    // Keep last 20 messages (~10 exchanges) to avoid this.
    const MAX_HISTORY = 20;
    const truncatedMessages = hasHistory && messages.length > MAX_HISTORY
      ? messages.slice(-MAX_HISTORY)
      : messages;

    // Figure out which message is the last user message in the truncated set
    let truncatedLastUserIdx = -1;
    for (let i = truncatedMessages.length - 1; i >= 0; i--) {
      if (truncatedMessages[i]!.role === "user") { truncatedLastUserIdx = i; break; }
    }

    let modifiedMessages;
    if (hasHistory) {
      // Clean metadata from all user messages in history; apply tool prompt only to last.
      // For vision-capable models, preserve `{type:"image"}` blocks alongside the text.
      modifiedMessages = truncatedMessages.map((m, idx) => {
        if (m.role === "user") {
          let content = "";
          let imgParts: Array<{ type: "image"; data: string; mimeType?: string }> = [];
          let docParts: Array<{
            type: "document";
            data: string;
            mimeType?: string;
            fileName?: string;
          }> = [];
          if (typeof m.content === "string") {
            content = m.content;
          } else if (Array.isArray(m.content)) {
            const parts = m.content as Array<{
              type: string;
              text?: string;
              data?: string;
              mimeType?: string;
              fileName?: string;
            }>;
            content = parts
              .filter((p) => p.type === "text")
              .map((p) => p.text || "")
              .join("");
            if (supportsImages) {
              imgParts = parts.filter(
                (p): p is { type: "image"; data: string; mimeType?: string } =>
                  p.type === "image" && Boolean(p.data),
              );
            }
            if (supportsDocuments) {
              docParts = parts.filter(
                (
                  p,
                ): p is {
                  type: "document";
                  data: string;
                  mimeType?: string;
                  fileName?: string;
                } => p.type === "document" && Boolean(p.data),
              );
            }
          }
          content = stripInboundMeta(content);
          // Apply tool prompt injection only to the last user message
          if (idx === truncatedLastUserIdx && injectTools) {
            content = getToolPrompt(api) + content;
          }
          const extraParts = [
            ...(supportsImages ? imgParts : []),
            ...(supportsDocuments ? docParts : []),
          ];
          if (extraParts.length > 0) {
            const textPart = content ? [{ type: "text", text: content }] : [];
            return { ...m, content: [...textPart, ...extraParts] };
          }
          return { ...m, content };
        }
        return m;
      });
    } else {
      const extraParts = [
        ...(supportsImages ? lastUserImages : []),
        ...(supportsDocuments ? lastUserDocuments : []),
      ];
      if (extraParts.length > 0) {
        const textPart = prompt ? [{ type: "text", text: prompt }] : [];
        modifiedMessages = [{ role: "user" as const, content: [...textPart, ...extraParts] }];
      } else {
        modifiedMessages = [{ role: "user" as const, content: prompt }];
      }
    }

    // Spread the original context to preserve the full type, then override.
    const modifiedContext = Object.assign({}, context, {
      messages: modifiedMessages,
      tools: [] as typeof context.tools,
      systemPrompt: "",
    });

    // Wrap the stream for tool extraction when either:
    // - Native API tools exist (hasAgentTools), or
    // - The model supports prompt-based tool injection (shouldInjectToolPrompt).
    // injectTools only controls whether we prepend the tool prompt — the
    // model may still output tool_json/XML blocks without the prompt.
    const shouldWrapForToolExtraction = shouldInjectToolPrompt(api) || hasAgentTools;
    if (!shouldWrapForToolExtraction) {
      // No tool support at all — just pass through with cleaned context
      return streamFn(model, modifiedContext, options);
    }

    // --- Wrap the output stream for tool call extraction ---
    //
    // KEY DESIGN: Buffer ALL events until the stream completes, then decide.
    // Old code forwarded text_delta events immediately — which meant
    // ```tool_json``` blocks appeared as raw text in the UI instead of
    // being intercepted and auto-executed as tool calls.
    return wrapOutputForToolExtraction(
      streamFn(model, modifiedContext, options),
      model,
    );
  };
}
