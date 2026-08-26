import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@mariozechner/pi-ai";
import path from "node:path";
import os from "node:os";
import {
  KimiWebClientBrowser,
  type KimiWebClientOptions,
} from "../providers/kimi-web-client-browser.js";
import { PersistedMap } from "../persisted-map.js";
import { stripInboundMeta } from "./strip-inbound-meta.js";

/** Persistent storage path: ~/.openclaw/kimi-sessions.json */
const SESSION_FILE = process.env.KIMI_SESSION_FILE
  || path.join(os.homedir(), ".openclaw", "kimi-sessions.json");

/** Maps sessionKey → Kimi conversation ID (persisted to disk). */
const sessionMap = new PersistedMap(SESSION_FILE);

// Flush sessions to disk on process exit
process.once("beforeExit", () => sessionMap.flush());

export function createKimiWebStreamFn(cookieOrJson: string): StreamFn {
  let options: KimiWebClientOptions;
  try {
    const parsed = JSON.parse(cookieOrJson);
    options = parsed;
  } catch {
    options = { cookie: cookieOrJson, userAgent: "Mozilla/5.0" };
  }
  const client = new KimiWebClientBrowser(options);

  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        await client.init();

        const sessionKey = (context as unknown as { sessionId?: string }).sessionId || "default";
        const conversationId = sessionMap.get(sessionKey);
        console.log(
          `[KimiWebStream] sessionKey="${sessionKey}" conversationId=${conversationId || "null"} mapSize=${sessionMap.size}`,
        );

        const messages = context.messages || [];

        // With chat_id, KIMI maintains conversation history server-side.
        // Only send the full history on first turn; subsequent turns only need
        // the latest user message (KIMI remembers the rest via chat_id).
        let prompt: string;
        if (conversationId) {
          // Continued conversation: just send the last user message
          const lastUserMsg = [...messages].toReversed().find((m) => (m.role as string) === "user");
          if (lastUserMsg) {
            if (typeof lastUserMsg.content === "string") {
              prompt = lastUserMsg.content;
            } else if (Array.isArray(lastUserMsg.content)) {
              prompt = (lastUserMsg.content as TextContent[])
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("");
            } else {
              prompt = "";
            }
          } else {
            prompt = "";
          }
        } else {
          // New conversation: build full context from history
          const parts: string[] = [];
          const systemPrompt = (context as unknown as { systemPrompt?: string }).systemPrompt || "";
          if (systemPrompt) {
            parts.push(`System: ${systemPrompt}`);
          }

          for (const m of messages) {
            const role = (m.role as string) === "user" ? "User"
              : (m.role as string) === "assistant" ? "Assistant"
              : (m.role as string) === "toolResult" ? "Tool"
              : "System";
            let content = "";
            if (typeof m.content === "string") {
              content = m.content;
            } else if (Array.isArray(m.content)) {
              for (const part of (m.content as unknown) as Record<string, unknown>[]) {
                if (part.type === "text" && typeof part.text === "string") content += part.text;
                else if (part.type === "thinking" && typeof part.thinking === "string") content += "<think>" + part.thinking + "</think>";
              }
            }
            if (content) {
              parts.push(`${role}: ${content}`);
            }
          }

          prompt = parts.length <= 1
            ? (parts[0]?.replace(/^(?:User|Assistant|Tool|System):\s*/, "") || "")
            : parts.join("\n\n") + "\n\nAssistant:";
        }

        if (!prompt) {
          throw new Error("No message found to send to KimiWeb API");
        }

        console.log(`[KimiWebStream] Starting run for session: ${sessionKey}`);
        console.log(`[KimiWebStream] Conversation ID: ${conversationId || "new"}`);
        console.log(`[KimiWebStream] Messages in context: ${messages.length}`);

        let responseStream: ReadableStream<Uint8Array> | null = null;
        try {
          responseStream = await client.chatCompletions({
            conversationId,
            message: prompt,
            model: model.id,
            signal: streamOptions?.signal,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Detect "conversation full/context too long" patterns and auto-clear session
          // Covers KIMI's various error messages about context overflow
          if (conversationId && /(对话已满|上下文.*(过长|超长|超过|已满)|请求过长|too many|conversation.*(full|limit|length)|message.*limit|token.*limit|context.*(length|limit|overflow)|request.*(large|long))/i.test(msg)) {
            console.log(`[KimiWebStream] Conversation full, clearing session ${sessionKey} and retrying...`);
            sessionMap.delete(sessionKey);
            // Retry with fresh conversation, but only the last few messages
            const recentMessages = messages.slice(-6);
            let retryPrompt: string;
            const parts: string[] = [];
            for (const m of recentMessages) {
              const role = (m.role as string) === "user" ? "User" : (m.role as string) === "assistant" ? "Assistant" : "System";
              let content = "";
              if (typeof m.content === "string") content = m.content;
              else if (Array.isArray(m.content)) {
                for (const part of (m.content as unknown) as Record<string, unknown>[]) {
                  if (part.type === "text" && typeof part.text === "string") content += part.text;
                }
              }
              if (content) parts.push(`${role}: ${content}`);
            }
            retryPrompt = parts.join("\n\n") + "\n\nAssistant:";
            responseStream = await client.chatCompletions({
              conversationId: undefined,
              message: retryPrompt,
              model: model.id,
              signal: streamOptions?.signal,
            });
          } else {
            throw err;
          }
        }

        if (!responseStream) {
          // Stale chat_id or API issue — clear session to start fresh next time
          if (conversationId) {
            console.log(`[KimiWebStream] Clearing stale session ${sessionKey}`);
            sessionMap.delete(sessionKey);
          }
          throw new Error("KimiWeb API returned empty response body");
        }

        const reader = responseStream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const indexMap = new Map<string, number>();
        let nextIndex = 0;
        const contentParts: (TextContent | ThinkingContent | ToolCall)[] = [];
        const accumulatedToolCalls: {
          id: string;
          name: string;
          arguments: string;
          index: number;
        }[] = [];

        const createPartial = (): AssistantMessage => {
          const msg: AssistantMessage = {
            role: "assistant",
            content: [...contentParts],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: accumulatedToolCalls.length > 0 ? "toolUse" : "stop",
            timestamp: Date.now(),
          };
          (msg as AssistantMessage & { thinking_enabled?: boolean }).thinking_enabled =
            contentParts.some((p) => p.type === "thinking");
          return msg;
        };

        let currentMode: "text" | "thinking" | "tool_call" = "text";
        let currentToolName = "";
        let currentToolIndex = 0;
        let tagBuffer = "";

        const emitDelta = (
          type: "text" | "thinking" | "toolcall",
          delta: string,
          forceId?: string,
        ) => {
          if (delta === "" && type !== "toolcall") {
            return;
          }
          const key = type === "toolcall" ? `tool_${currentToolIndex}` : type;

          if (!indexMap.has(key)) {
            const index = nextIndex++;
            indexMap.set(key, index);
            if (type === "text") {
              contentParts[index] = { type: "text", text: "" };
              stream.push({ type: "text_start", contentIndex: index, partial: createPartial() });
            } else if (type === "thinking") {
              contentParts[index] = { type: "thinking", thinking: "" };
              stream.push({
                type: "thinking_start",
                contentIndex: index,
                partial: createPartial(),
              });
            } else if (type === "toolcall") {
              const toolId = forceId || `call_${Date.now()}_${index}`;
              contentParts[index] = {
                type: "toolCall",
                id: toolId,
                name: currentToolName,
                arguments: {},
              };
              accumulatedToolCalls[currentToolIndex] = {
                id: toolId,
                name: currentToolName,
                arguments: "",
                index: currentToolIndex,
              };
              stream.push({
                type: "toolcall_start",
                contentIndex: index,
                partial: createPartial(),
              });
            }
          }

          const index = indexMap.get(key)!;
          if (type === "text") {
            (contentParts[index] as TextContent).text += delta;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "thinking") {
            (contentParts[index] as ThinkingContent).thinking += delta;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "toolcall") {
            accumulatedToolCalls[currentToolIndex].arguments += delta;
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          }
        };

        const pushDelta = (delta: string, forceType?: "text" | "thinking") => {
          if (!delta) {
            return;
          }
          if (forceType === "thinking") {
            emitDelta("thinking", delta);
            return;
          }
          tagBuffer += delta;

          const checkTags = () => {
            const thinkStart = tagBuffer.match(/<think\b[^<>]*>/i);
            const thinkEnd = tagBuffer.match(/<\/think\b[^<>]*>/i);
            // Match: <tool_call name="x" id="y"> or <tool_call> (bare, KIMI uses JSON body)
            const toolCallStart = tagBuffer.match(
              /<tool_call\s*(?:id=['"]?([^'"]+)['"]?\s*)?(?:name=['"]?([^'"]+)['"]?\s*)?>/i,
            );
            const toolCallEnd = tagBuffer.match(/<\/tool_call\s*>/i);

            const indices = [
              {
                type: "think_start",
                idx: thinkStart?.index ?? -1,
                len: thinkStart?.[0].length ?? 0,
              },
              { type: "think_end", idx: thinkEnd?.index ?? -1, len: thinkEnd?.[0].length ?? 0 },
              {
                type: "tool_start",
                idx: toolCallStart?.index ?? -1,
                len: toolCallStart?.[0].length ?? 0,
                id: toolCallStart?.[1],
                name: toolCallStart?.[2],
              },
              {
                type: "tool_end",
                idx: toolCallEnd?.index ?? -1,
                len: toolCallEnd?.[0].length ?? 0,
              },
            ]
              .filter((t) => t.idx !== -1)
              .toSorted((a, b) => a.idx - b.idx);

            if (indices.length > 0) {
              const first = indices[0];
              const before = tagBuffer.slice(0, first.idx);
              if (before) {
                if (currentMode === "thinking") {
                  emitDelta("thinking", before);
                } else if (currentMode === "tool_call") {
                  emitDelta("toolcall", before);
                } else {
                  emitDelta("text", before);
                }
              }

              if (first.type === "think_start") {
                currentMode = "thinking";
              } else if (first.type === "think_end") {
                currentMode = "text";
              } else if (first.type === "tool_start") {
                currentMode = "tool_call";
                // Bare <tool_call> (KIMI format) — name extracted from JSON body in tool_end
                currentToolName = first.name || "__pending__";
                emitDelta("toolcall", "", first.id);
              } else if (first.type === "tool_end") {
                const index = indexMap.get(`tool_${currentToolIndex}`);
                if (index !== undefined) {
                  const part = contentParts[index] as ToolCall;
                  let argStr = accumulatedToolCalls[currentToolIndex].arguments || "{}";

                  let cleanedArg = argStr.trim();
                  // Strip markdown fenced code blocks that may wrap the JSON body.
                  // KIMI sometimes nests ```tool_json / ```json inside <tool_call> tags.
                  if (cleanedArg.startsWith("```tool_json")) {
                    cleanedArg = cleanedArg.substring(11);
                  } else if (cleanedArg.startsWith("```json")) {
                    cleanedArg = cleanedArg.substring(7);
                  } else if (cleanedArg.startsWith("```")) {
                    cleanedArg = cleanedArg.substring(3);
                  }
                  if (cleanedArg.endsWith("```")) {
                    cleanedArg = cleanedArg.substring(0, cleanedArg.length - 3);
                  }
                  cleanedArg = cleanedArg.trim();

                  try {
                    const parsed = JSON.parse(cleanedArg);
                    // KIMI bare tag: {"tool":"name","arguments":{...}}
                    if (typeof parsed.tool === "string") {
                      currentToolName = parsed.tool;
                      part.name = parsed.tool;
                    }
                    // KIMI may use "arguments" or "parameters" key depending on prompt format.
                    // Fall back to the whole object for bare payloads like {"command":"ls"}.
                    part.arguments =
                      (parsed.arguments as Record<string, unknown>) ??
                      (parsed.parameters as Record<string, unknown>) ??
                      parsed;
                  } catch (e) {
                    part.arguments = { raw: argStr };
                    console.error(
                      `[KimiWebStream] Failed to parse tool JSON: ${argStr.slice(0, 200)}`,
                    );
                  }
                  stream.push({
                    type: "toolcall_end",
                    contentIndex: index,
                    toolCall: part,
                    partial: createPartial(),
                  });
                }
                currentMode = "text";
                currentToolIndex++;
                currentToolName = "";
              }
              tagBuffer = tagBuffer.slice(first.idx + first.len);
              checkTags();
            } else {
              const lastAngle = tagBuffer.lastIndexOf("<");
              if (lastAngle === -1) {
                const mode =
                  currentMode === "thinking"
                    ? "thinking"
                    : currentMode === "tool_call"
                      ? "toolcall"
                      : "text";
                emitDelta(mode, tagBuffer);
                tagBuffer = "";
              } else if (lastAngle > 0) {
                const safe = tagBuffer.slice(0, lastAngle);
                const mode =
                  currentMode === "thinking"
                    ? "thinking"
                    : currentMode === "tool_call"
                      ? "toolcall"
                      : "text";
                emitDelta(mode, safe);
                tagBuffer = tagBuffer.slice(lastAngle);
              }
            }
          };
          checkTags();
        };

        const processLine = (line: string) => {
          if (!line || !line.startsWith("data:")) {
            return;
          }

          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]" || !dataStr) {
            return;
          }

          try {
            const data = JSON.parse(dataStr);

            // Extract conversation ID from response
            if (data.sessionId) {
              sessionMap.set(sessionKey, data.sessionId);
            }

            // Extract content delta
            const delta =
              data.choices?.[0]?.delta?.content ?? data.text ?? data.content ?? data.delta;
            if (typeof delta === "string" && delta) {
              pushDelta(delta);
            }
          } catch {
            // Ignore parse errors
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              processLine(buffer.trim());
            }
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const combined = buffer + chunk;
          const parts = combined.split("\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            processLine(part.trim());
          }
        }

        // Flush remaining tag buffer
        if (tagBuffer) {
          const mode =
            (currentMode as string) === "thinking"
              ? "thinking"
              : (currentMode as string) === "tool_call"
                ? "toolcall"
                : "text";
          emitDelta(mode, tagBuffer);
        }

        console.log(
          `[KimiWebStream] Stream completed. Parts: ${contentParts.length}, Tools: ${accumulatedToolCalls.length}`,
        );

        stream.push({
          type: "done",
          reason: accumulatedToolCalls.length > 0 ? "toolUse" : "stop",
          message: createPartial(),
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        } as unknown as Parameters<typeof stream.push>[0]);
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
