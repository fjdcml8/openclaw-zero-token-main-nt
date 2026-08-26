import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import {
  DeepSeekWebClient,
  type DeepSeekWebClientOptions,
} from "../providers/deepseek-web-client.js";
import { normalizeFullwidthTagDelimiters } from "../tool-calling/web-tool-parser.js";

// Helper to strip messages for web providers
function stripForWebProvider(prompt: string): string {
  return prompt;
}

// model id → (DeepSeek web `model_type`, thinking toggle).
// "default" = the fast model (currently DeepSeek V4 Flash), "expert" = the stronger
// model (currently DeepSeek V4 Pro). DeepSeek pins model_type per chat thread, so
// switching model_type requires a fresh DeepSeek session (see session handling below).
const DEEPSEEK_MODEL_SPECS: Record<string, { modelType: string; thinking: boolean }> = {
  "deepseek-chat": { modelType: "default", thinking: false },
  "deepseek-reasoner": { modelType: "default", thinking: true },
  "deepseek-chat-search": { modelType: "default", thinking: true },
  "deepseek-reasoner-search": { modelType: "default", thinking: true },
  "deepseek-v4-flash": { modelType: "default", thinking: false },
  "deepseek-v4-flash-search": { modelType: "default", thinking: true },
  "deepseek-v4-pro": { modelType: "expert", thinking: true },
  "deepseek-v4-pro-search": { modelType: "expert", thinking: true },
  // vision model_type (DeepSeek V4 Flash Vision Exp) is a reasoning model: with
  // thinking disabled it streams its *planning* as response content and never
  // emits the tool_call block (narrates intent instead of executing). Keep
  // thinking on so planning goes to the thinking channel and the actual
  // <tool_call> follows in the response.
  "deepseek-v4-flash-vision-exp": { modelType: "vision", thinking: true },
  "deepseek-v4-flash-vision-exp-search": { modelType: "vision", thinking: true },
};

function deepseekModelSpec(modelId: string): { modelType: string; thinking: boolean } {
  return DEEPSEEK_MODEL_SPECS[modelId] ?? { modelType: "default", thinking: true };
}

// Map an image content block's mimeType to a filename extension for upload.
function mimeToExt(mimeType?: string): string {
  const m = (mimeType || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "jpg";
}

// Map a document content block's mimeType to a filename extension for upload
// (used only when the attachment carries no fileName).
function mimeToDocExt(mimeType?: string): string {
  const m = (mimeType || "").toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("wordprocessingml") || m.includes("msword")) return "docx";
  if (m.includes("spreadsheetml") || m.includes("ms-excel")) return "xlsx";
  if (m.includes("presentationml") || m.includes("ms-powerpoint")) return "pptx";
  if (m.includes("markdown")) return "md";
  if (m.includes("csv")) return "csv";
  if (m.includes("rtf")) return "rtf";
  if (m.includes("plain") || m.includes("text")) return "txt";
  return "txt";
}

// Infer the OpenClaw tool name from nested <parameter name="..."> arguments
// (Anthropic-style tool_call the DeepSeek V4 Pro model emits natively).
function inferToolNameFromParams(params: Record<string, unknown>): string {
  if ("command" in params) return "exec";
  if ("path" in params && "content" in params) return "write";
  if ("path" in params) return "read";
  if ("query" in params) return "web_search";
  if ("url" in params) return "web_fetch";
  if ("text" in params) return "message";
  return "exec";
}

// Keep track of session IDs per session key to avoid creating too many web chat sessions.
// Stores the session's model_type so a model switch can start a fresh DeepSeek thread.
const sessionMap = new Map<string, { id: string; modelType: string }>();
const parentMessageMap = new Map<string, string | number>();

type MessageContentPart = {
  type: string;
  text?: string;
  name?: string;
  arguments?: string;
  index?: number;
  id?: string;
};

export function createDeepseekWebStreamFn(cookieOrJson: string): StreamFn {
  let options: string | DeepSeekWebClientOptions;
  try {
    const parsed = JSON.parse(cookieOrJson);
    if (typeof parsed === "string") {
      options = { cookie: parsed };
    } else {
      options = parsed;
    }
  } catch {
    options = { cookie: cookieOrJson };
  }
  const client = new DeepSeekWebClient(options);

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        await client.init();

        const sessionKey = (context as unknown as { sessionId?: string }).sessionId || "default";
        const spec = deepseekModelSpec(model.id);
        let dsSessionId: string | undefined;
        let parentId: string | number | undefined;
        const cached = sessionMap.get(sessionKey);

        if (!cached || cached.modelType !== spec.modelType) {
          // New session, or the requested model changed model_type (default ↔ expert).
          // DeepSeek pins model_type per thread, so a model switch starts a fresh thread.
          const session = await client.createChatSession();
          dsSessionId = session.chat_session_id || "";
          sessionMap.set(sessionKey, { id: dsSessionId, modelType: spec.modelType });
          parentMessageMap.delete(sessionKey);
          parentId = undefined;
        } else {
          dsSessionId = cached.id;
          parentId = parentMessageMap.get(sessionKey);
        }

        const messages = context.messages || [];
        const systemPrompt = (context as unknown as { systemPrompt?: string }).systemPrompt || "";
        console.log(
          `[DeepseekWebStream] Context messages count: ${messages.length}, hasSystemPrompt: ${!!systemPrompt}`,
        );
        let prompt = "";
        // Image content blocks ({ type: "image", data: base64, mimeType }) collected from
        // user messages / tool results, uploaded for the DeepSeek `vision` model_type.
        const imageParts: { data: string; mimeType?: string }[] = [];
        // Document content blocks ({ type: "document", data: base64, mimeType?, fileName? })
        // forwarded unmodified to DeepSeek web via ref_file_ids — the web AI reads
        // documents natively, so we upload the raw file rather than text-extracting it.
        const documentParts: { data: string; mimeType?: string; fileName?: string }[] = [];

        if (!parentId) {
          // First turn or new session: Aggregate all history including System Prompt
          const historyParts: string[] = [];

          const tools = context.tools || [];
          let systemPromptContent = systemPrompt;

          if (tools.length > 0) {
            let toolPrompt = "\n## Available Tools\n";
            for (const tool of tools) {
              toolPrompt += `- ${tool.name}: ${tool.description}\n`;
            }
            systemPromptContent += toolPrompt;
          }

          if (systemPromptContent && !messages.some((m) => (m.role as string) === "system")) {
            console.log(
              `[DeepseekWebStream] Prepending separate systemPrompt (length=${systemPromptContent.length})`,
            );
            historyParts.push(`System: ${systemPromptContent}`);
          }

          for (const m of messages) {
            const role =
              (m.role as string) === "user" || (m.role as string) === "toolResult"
                ? "User"
                : "Assistant";
            let content = "";

            if (m.role === "toolResult") {
              const tr = m as unknown as ToolResultMessage;
              let resultText = "";
              if (Array.isArray(tr.content)) {
                for (const part of tr.content) {
                  if (part.type === "text") {
                    resultText += part.text;
                  } else if (part.type === "image") {
                    const img = part as { data: string; mimeType?: string };
                    if (img.data) imageParts.push({ data: img.data, mimeType: img.mimeType });
                  } else if ((part as { type?: string }).type === "document") {
                    const doc = part as { data: string; mimeType?: string; fileName?: string };
                    if (doc.data)
                      documentParts.push({
                        data: doc.data,
                        mimeType: doc.mimeType,
                        fileName: doc.fileName,
                      });
                  }
                }
              }
              content = `\n<tool_response id="${tr.toolCallId}" name="${tr.toolName}">\n${resultText}\n</tool_response>\n`;
            } else if (Array.isArray(m.content)) {
              for (const part of m.content) {
                if (part.type === "text") {
                  content += part.text;
                } else if (part.type === "thinking") {
                  content += `<think>\n${part.thinking}\n</think>\n`;
                } else if (part.type === "toolCall") {
                  const tc = part;
                  content += `<tool_call id="${tc.id}" name="${tc.name}">${JSON.stringify(tc.arguments)}</tool_call>`;
                } else if (part.type === "image") {
                  const img = part as { data: string; mimeType?: string };
                  if (img.data) imageParts.push({ data: img.data, mimeType: img.mimeType });
                } else if ((part as { type?: string }).type === "document") {
                  const doc = part as { data: string; mimeType?: string; fileName?: string };
                  if (doc.data)
                    documentParts.push({
                      data: doc.data,
                      mimeType: doc.mimeType,
                      fileName: doc.fileName,
                    });
                }
              }
            } else {
              content = String(m.content);
            }

            if ((m.role as string) === "user" && content) {
              content = stripForWebProvider(content) || content;
            }

            console.log(
              `[DeepseekWebStream] Message[${messages.indexOf(m)}] role=${m.role} length=${content.length} preview=${content.slice(0, 50).replace(/\n/g, " ")}`,
            );
            historyParts.push(`${role}: ${content}`);
          }

          prompt = historyParts.join("\n\n");

          // DeepSeek web rejects prompts above ~170K chars on the expert (V4 Pro)
          // model ("内容超长 / input_exceeds_limit"), while the fast model tolerates
          // ~189K+. Cap the aggregated first-turn history so long conversations still
          // work: drop the oldest messages first, always preserving the System block
          // and the most recent message.
          const MAX_HISTORY_CHARS = spec.modelType === "expert" ? 135_000 : 300_000;
          if (prompt.length > MAX_HISTORY_CHARS) {
            const dropFrom = historyParts[0]?.startsWith("System:") ? 1 : 0;
            while (historyParts.length > dropFrom + 1 && prompt.length > MAX_HISTORY_CHARS) {
              historyParts.splice(dropFrom, 1);
              prompt = historyParts.join("\n\n");
            }
            if (prompt.length > MAX_HISTORY_CHARS) {
              prompt = prompt.slice(-MAX_HISTORY_CHARS);
            }
            console.log(
              `[DeepseekWebStream] History truncated to ${prompt.length} chars (expert input limit guard)`,
            );
          }
        } else {
          // Continuing turn: Check if the last record is a ToolResult or User message
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === "toolResult") {
            const tr = lastMsg as unknown as ToolResultMessage;
            let resultText = "";
            if (Array.isArray(tr.content)) {
              for (const part of tr.content) {
                if (part.type === "text") {
                  resultText += part.text;
                } else if (part.type === "image") {
                  const img = part as { data: string; mimeType?: string };
                  if (img.data) imageParts.push({ data: img.data, mimeType: img.mimeType });
                } else if ((part as { type?: string }).type === "document") {
                  const doc = part as { data: string; mimeType?: string; fileName?: string };
                  if (doc.data)
                    documentParts.push({
                      data: doc.data,
                      mimeType: doc.mimeType,
                      fileName: doc.fileName,
                    });
                }
              }
            }
            prompt = `\n<tool_response id="${tr.toolCallId}" name="${tr.toolName}">\n${resultText}\n</tool_response>\n\nPlease proceed based on this tool result.`;
          } else {
            // Standard user message logic
            const lastUserMessage = [...messages].toReversed().find((m) => m.role === "user");
            if (lastUserMessage) {
              if (typeof lastUserMessage.content === "string") {
                prompt = stripForWebProvider(lastUserMessage.content) || lastUserMessage.content;
              } else if (Array.isArray(lastUserMessage.content)) {
                const parts = lastUserMessage.content as (MessageContentPart & {
                  data?: string;
                  mimeType?: string;
                })[];
                const raw = parts
                  .filter((part) => part.type === "text")
                  .map((part) => (part as TextContent).text)
                  .join("");
                prompt = stripForWebProvider(raw) || raw;
                for (const part of parts) {
                  if (part.type === "image" && part.data) {
                    imageParts.push({ data: part.data, mimeType: part.mimeType });
                  } else if (part.type === "document" && part.data) {
                    const doc = part as {
                      data: string;
                      mimeType?: string;
                      fileName?: string;
                    };
                    documentParts.push({
                      data: doc.data,
                      mimeType: doc.mimeType,
                      fileName: doc.fileName,
                    });
                  }
                }
              }
            }
          }
        }

        console.log(
          `[DeepseekWebStream] Starting run for session: ${sessionKey}. DS session: ${dsSessionId}. Parent: ${parentId}. Prompt length: ${prompt.length}`,
        );
        console.log(`[DeepseekWebStream] Full Prompt Preview: ${prompt.slice(0, 500)}...`);

        if (!prompt && imageParts.length === 0 && documentParts.length === 0) {
          console.error(`[DeepseekWebStream] No prompt to send:`, JSON.stringify(messages));
          throw new Error("No message found to send to DeepSeek web API");
        }

        // Vision (识图) mode: upload every image content block to DeepSeek, fork it to the
        // `vision` model_type, and reference the resulting file ids via ref_file_ids. Images
        // must be forked or the vision model cannot read them (reverse-engineered from the
        // DeepSeek web app). Only done for the vision model — text-only models skip uploads.
        const visionFileIds: string[] = [];
        if (spec.modelType === "vision" && imageParts.length > 0) {
          if (!prompt) {
            prompt = "请描述这张图片的内容。";
          }
          for (const [i, img] of imageParts.entries()) {
            try {
              const buffer = Buffer.from(img.data, "base64");
              const ext = mimeToExt(img.mimeType);
              const fileId = await client.uploadFile(
                buffer,
                `vision_${Date.now()}_${i}.${ext}`,
              );
              const forkedId = await client.forkFileTask(fileId, "vision");
              visionFileIds.push(forkedId);
              console.log(
                `[DeepseekWebStream] Attached vision image #${i}: ${forkedId} (${img.mimeType || ext})`,
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(
                `[DeepseekWebStream] Vision image upload failed (image #${i}): ${msg}`,
              );
            }
          }
        }

        // Document upload: forward every `{type:"document"}` content block unmodified to
        // DeepSeek web and reference it via ref_file_ids. DeepSeek web reads documents
        // natively (the web AI recognizes PDF/Word/Excel/PPT/txt), so no text extraction
        // happens here — the raw file bytes are uploaded as-is. For the vision model_type,
        // uploaded files must be forked to `vision` (same as images); default/expert use
        // the uploaded file id directly.
        const documentFileIds: string[] = [];
        if (documentParts.length > 0) {
          if (!prompt) {
            prompt = "请阅读此文档。";
          }
          for (const [i, doc] of documentParts.entries()) {
            try {
              const buffer = Buffer.from(doc.data, "base64");
              const ext = mimeToDocExt(doc.mimeType);
              const baseName = doc.fileName || `document_${Date.now()}_${i}.${ext}`;
              let fileId = await client.uploadFile(buffer, baseName);
              if (spec.modelType === "vision") {
                fileId = await client.forkFileTask(fileId, "vision");
              }
              documentFileIds.push(fileId);
              console.log(
                `[DeepseekWebStream] Attached document #${i}: ${fileId} (${doc.mimeType || ext})`,
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(
                `[DeepseekWebStream] Document upload failed (document #${i}): ${msg}`,
              );
            }
          }
        }

        // Search is modeled as a distinct `-search` model variant (mirroring Kimi). When the
        // caller doesn't pass an explicit `searchEnabled`, infer it from the model id so the
        // `-search` variants actually toggle DeepSeek's web search instead of being no-ops.
        const searchEnabled =
          (options as unknown as { searchEnabled?: boolean })?.searchEnabled ??
          model.id.includes("search");
        const preempt = (options as unknown as { preempt?: boolean })?.preempt ?? false;
        const fileIds = [
          ...visionFileIds,
          ...documentFileIds,
          ...((options as unknown as { fileIds?: string[] })?.fileIds || []),
        ];

        const responseStream = await client.chatCompletions({
          sessionId: dsSessionId,
          parentMessageId: parentId,
          message: prompt,
          model: model.id,
          modelType: spec.modelType,
          thinkingEnabled: spec.thinking,
          searchEnabled,
          preempt,
          fileIds,
          signal: options?.signal,
        });

        if (!responseStream) {
          throw new Error("DeepSeek Web API returned empty response body");
        }

        const reader = responseStream.getReader();
        const decoder = new TextDecoder();
        let accumulatedContent = "";
        let accumulatedReasoning = "";
        const accumulatedToolCalls: MessageContentPart[] = [];
        let buffer = "";
        // Captures DeepSeek-side errors sent as SSE events (e.g. input_exceeds_limit),
        // which otherwise complete silently with Content: 0.
        let streamError = "";

        // Sequential indexing for pi-ai AssistantMessage events
        const indexMap = new Map<string, number>();
        let nextIndex = 0;
        const contentParts: (TextContent | ThinkingContent | ToolCall)[] = [];

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
          (msg as unknown as { thinking_enabled: boolean }).thinking_enabled =
            !!accumulatedReasoning;
          return msg;
        };

        // Stateful parser for tags in the text stream
        let currentMode: "text" | "thinking" | "tool_call" = "text";
        // DeepSeek expert streams reasoning as a `THINK` fragment and the final answer as a
        // `RESPONSE` fragment. Bare `v` deltas carry no fragment type, so track the active
        // fragment kind to route them to the right stream (thinking vs text).
        let activeFragmentKind: "thinking" | "text" | null = null;
        let currentToolName = "";
        let currentToolIndex = 0;
        let tagBuffer = "";
        // State for Anthropic-style nested <parameter name="X">value</parameter> tool calls
        let currentParamName = "";
        let currentParamValue = "";
        let paramsMap: Record<string, string> = {};

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
                type: "tool_call",
                name: currentToolName,
                arguments: "",
                index: currentToolIndex,
                id: toolId,
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
            accumulatedContent += delta;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "thinking") {
            (contentParts[index] as ThinkingContent).thinking += delta;
            accumulatedReasoning += delta;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "toolcall") {
            accumulatedToolCalls[currentToolIndex].arguments += delta;
            if (currentParamName) {
              currentParamValue += delta;
            }
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          }
        };

        // Surface a server-side web search query as a "[Researching: ...]" annotation.
        const emitResearching = (query: string) => {
          const searchMsg = `\n> [Researching: ${query}...]\n`;
          if (currentMode === "thinking") {
            emitDelta("thinking", searchMsg);
          } else {
            emitDelta("text", searchMsg);
          }
        };

        const pushDelta = (delta: string, forceType?: "text" | "thinking") => {
          if (!delta) {
            return;
          }

          // Junk token filtering (multiple Unicode variants of end_of_thinking)
          const JUNK_TOKENS = [
            "<｜end▁of▁thinking｜>",
            "<|end▁of▁thinking|>",
            "<｜end_of_thinking｜>",
            "<|end_of_thinking|>",
            "<|endoftext|>",
          ];
          if (JUNK_TOKENS.includes(delta)) {
            console.log(`[DeepseekWebStream] Filtering junk token: ${delta}`);
            return;
          }

          if (forceType === "thinking") {
            emitDelta("thinking", delta);
            return;
          }

          tagBuffer += delta;

          const checkTags = () => {
            // Normalize full-width pipe delimiters that DeepSeek emits around tag
            // names: <DSML｜｜tool_call> → <tool_call>, </DSML｜｜tool_call> → </tool_call>,
            // plus the older <｜ｐｅｆ｜tool_call> / <｜｜tool_call> / <｜DSML｜tool_call> forms.
            // Shared with the parser so stream and extraction agree on the same form.
            if (tagBuffer.includes("｜")) {
              tagBuffer = normalizeFullwidthTagDelimiters(tagBuffer);
            }
            const thinkStartMatch = tagBuffer.match(/<(?:think(?:ing)?|thought)\b[^<>]*>/i);
            const thinkEndMatch = tagBuffer.match(/<\/(?:think(?:ing)?|thought)\b[^<>]*>/i);
            const finalStartMatch = tagBuffer.match(/<final\b[^<>]*>/i);
            const finalEndMatch = tagBuffer.match(/<\/final\b[^<>]*>/i);
            // Support both <tool_call id="x" name="y"> and <tool_call name="y" id="x"> orders,
            // as well as id-only or name-only variants from DeepSeek, plus the bare
            // <tool_call> the V4 Pro model emits with nested <parameter name="..."> args.
            // Anthropic Messages API <invoke name="x">...</invoke> and the plural
            // <tool_calls name="x">...</tool_calls> wrapper are treated as aliases.
            // NOTE: bare <tool_calls> is deliberately NOT a start tag — it is a
            // transparent wrapper whose inner <tool_call> items are parsed normally.
            const toolCallStartMatch =
              tagBuffer.match(
                /<(?:tool_call|tool_calls|invoke)\s+(?:id=['"]?([^'"]+)['"]?\s+)?name=['"]?([^'"]+)['"]?(?:\s+id=['"]?([^'"]+)['"]?)?\s*>/i,
              ) || tagBuffer.match(/<(?:tool_call|tool_calls|invoke)\s+id=['"]?([^'"]+)['"]?\s*>/i)
              || tagBuffer.match(/<(?:tool_call|invoke)\s*>/i);
            const toolCallEndMatch = tagBuffer.match(/<\/(?:tool_call|tool_calls|invoke)\b[^<>]*>/i);
            // Anthropic-style nested parameter tags inside <tool_call>: <parameter name="command">...</parameter>
            // Tolerate extra attributes after the name (e.g. <parameter name="command" string="false">).
            const paramStartMatch = tagBuffer.match(/<parameter\s+name=['"]?([^'"]+)['"]?[^>]*>/i);
            const paramEndMatch = tagBuffer.match(/<\/parameter\b[^<>]*>/i);
            const replyMatch = tagBuffer.match(/\[\[reply_to_current\]\]/i);
            const malformedThinkMatch = tagBuffer.match(/\n?think\s*>/i);

            // Priority: find the first occurring tag
            const indices = [
              {
                type: "think_start",
                idx: thinkStartMatch ? thinkStartMatch.index! : -1,
                len: thinkStartMatch ? thinkStartMatch[0].length : 0,
              },
              {
                type: "think_end",
                idx: thinkEndMatch ? thinkEndMatch.index! : -1,
                len: thinkEndMatch ? thinkEndMatch[0].length : 0,
              },
              {
                type: "final_start",
                idx: finalStartMatch ? finalStartMatch.index! : -1,
                len: finalStartMatch ? finalStartMatch[0].length : 0,
              },
              {
                type: "final_end",
                idx: finalEndMatch ? finalEndMatch.index! : -1,
                len: finalEndMatch ? finalEndMatch[0].length : 0,
              },
              {
                type: "tool_call_start",
                idx: toolCallStartMatch ? toolCallStartMatch.index! : -1,
                len: toolCallStartMatch ? toolCallStartMatch[0].length : 0,
                id: toolCallStartMatch ? toolCallStartMatch[3] || toolCallStartMatch[1] : null,
                name: toolCallStartMatch
                  ? toolCallStartMatch[2] || toolCallStartMatch[1] || ""
                  : "",
              },
              {
                type: "tool_call_end",
                idx: toolCallEndMatch ? toolCallEndMatch.index! : -1,
                len: toolCallEndMatch ? toolCallEndMatch[0].length : 0,
              },
              {
                type: "reply_marker",
                idx: replyMatch ? replyMatch.index! : -1,
                len: replyMatch ? replyMatch[0].length : 0,
              },
              {
                type: "think_start", // Treat malformed think> as start
                idx: malformedThinkMatch ? malformedThinkMatch.index! : -1,
                len: malformedThinkMatch ? malformedThinkMatch[0].length : 0,
              },
              {
                type: "param_start",
                idx: paramStartMatch ? paramStartMatch.index! : -1,
                len: paramStartMatch ? paramStartMatch[0].length : 0,
                name: paramStartMatch ? paramStartMatch[1] : null,
              },
              {
                type: "param_end",
                idx: paramEndMatch ? paramEndMatch.index! : -1,
                len: paramEndMatch ? paramEndMatch[0].length : 0,
              },
            ]
              .filter((tag) => tag.idx !== -1)
              .toSorted((a, b) => a.idx - b.idx);

            if (indices.length > 0) {
              const first = indices[0];
              console.log(`[DeepseekWebStream] Tag detected: ${first.type} at ${first.idx}`);
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
              } else if (first.type === "final_start") {
                currentMode = "text";
              } else if (first.type === "final_end") {
                currentMode = "text";
              } else if (first.type === "reply_marker") {
                currentMode = "text";
              } else if (first.type === "tool_call_start") {
                currentMode = "tool_call";
                currentToolName = first.name!;
                const toolId = first.id || `call_${Date.now()}_${currentToolIndex}`;
                emitDelta("toolcall", "", toolId); // Trigger start event with specific ID
              } else if (first.type === "param_start") {
                // Structural tag inside <tool_call> — collect the parameter name.
                // Outside a tool_call, keep it as literal text.
                if (currentMode === "tool_call") {
                  currentParamName = first.name || "";
                  currentParamValue = "";
                } else {
                  emitDelta("text", tagBuffer.slice(first.idx, first.idx + first.len));
                }
              } else if (first.type === "param_end") {
                if (currentMode === "tool_call") {
                  // A </parameter> inside a tool_call block is structural, never
                  // assistant text. Close an open <parameter name="X"> if there is
                  // one; otherwise swallow the stray tag. The vision model appends
                  // a bare </parameter> after raw JSON args (no matching open tag),
                  // and leaking it into the visible text leaves the tool block
                  // half-hidden in the UI.
                  if (currentParamName) {
                    paramsMap[currentParamName] = currentParamValue;
                  }
                  currentParamName = "";
                  currentParamValue = "";
                } else {
                  emitDelta("text", tagBuffer.slice(first.idx, first.idx + first.len));
                }
              } else if (first.type === "tool_call_end") {
                const key = `tool_${currentToolIndex}`;
                const index = indexMap.get(key);
                if (index !== undefined) {
                  const part = contentParts[index] as ToolCall;
                  const argStr = accumulatedToolCalls[currentToolIndex].arguments || "";
                  // Close any open <parameter> so a trailing value isn't lost
                  if (currentParamName) {
                    paramsMap[currentParamName] = currentParamValue;
                    currentParamName = "";
                    currentParamValue = "";
                  }

                  let finalArgs: Record<string, unknown>;
                  if (Object.keys(paramsMap).length > 0) {
                    // Anthropic-style nested <parameter name="X">value</parameter> format
                    finalArgs = { ...paramsMap };
                    if (!part.name) {
                      part.name = inferToolNameFromParams(finalArgs);
                      accumulatedToolCalls[currentToolIndex].name = part.name;
                    }
                  } else {
                    try {
                      finalArgs = JSON.parse(argStr || "{}");
                    } catch {
                      // Fallback: parse XML-style arguments like <path>...</path><content>...</content>
                      const xmlArgs: Record<string, unknown> = {};
                      const xmlTagPattern = /<([a-zA-Z_][a-zA-Z0-9_]*)\s*[^>]*>([\s\S]*?)<\/\1>/g;
                      let xmlMatch;
                      while ((xmlMatch = xmlTagPattern.exec(argStr)) !== null) {
                        const xmlKey = xmlMatch[1];
                        const xmlValue = xmlMatch[2].trim();
                        try {
                          xmlArgs[xmlKey] = JSON.parse(xmlValue);
                        } catch {
                          xmlArgs[xmlKey] = xmlValue;
                        }
                      }
                      finalArgs = Object.keys(xmlArgs).length > 0 ? xmlArgs : { raw: argStr };
                    }
                  }
                  part.arguments = finalArgs;
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
                currentParamName = "";
                currentParamValue = "";
                paramsMap = {};
              }

              tagBuffer = tagBuffer.slice(first.idx + first.len);
              checkTags();
            } else {
              // No complete tags. Emit "safe" part of buffer.
              // Safe part is anything before the last '<'
              const lastAngle = tagBuffer.lastIndexOf("<");
              if (lastAngle === -1) {
                if (currentMode === "thinking") {
                  emitDelta("thinking", tagBuffer);
                } else if (currentMode === "tool_call") {
                  emitDelta("toolcall", tagBuffer);
                } else {
                  emitDelta("text", tagBuffer);
                }
                tagBuffer = "";
              } else if (lastAngle >= 0) {
                const safe = tagBuffer.slice(0, lastAngle);
                if (currentMode === "thinking") {
                  emitDelta("thinking", safe);
                } else if (currentMode === "tool_call") {
                  emitDelta("toolcall", safe);
                } else {
                  emitDelta("text", safe);
                }
                tagBuffer = tagBuffer.slice(lastAngle);
              }
              // If lastAngle is 0, we must keep it in buffer to see if it's a tag
            }
          };

          checkTags();
        };

        const processLine = (line: string) => {
          if (!line) {
            return;
          }

          if (line.startsWith("event: ")) {
            return; // We don't strictly need currentEvent if we trust the data structure
          }

          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") {
              return;
            }
            if (!dataStr) {
              return;
            }

            try {
              const data = JSON.parse(dataStr);
              // Surface DeepSeek-side error events (e.g. input_exceeds_limit) instead
              // of silently completing with Content: 0.
              if (data.type === "error") {
                streamError = `${String(data.content || "DeepSeek 返回错误")}${
                  data.finish_reason ? ` (${data.finish_reason})` : ""
                }`;
                return;
              }
              // Capture session/message continuity
              if (data.response_message_id) {
                if (data.response_message_id !== parentMessageMap.get(sessionKey)) {
                  console.log(
                    `[DeepseekWebStream] New parentMessageId: ${data.response_message_id}`,
                  );
                  parentMessageMap.set(sessionKey, data.response_message_id);
                }
              }

              // 1. Path update or explicit type for reasoning
              if (
                (data.p?.includes("reasoning") || data.type === "thinking") &&
                typeof data.v === "string"
              ) {
                pushDelta(data.v, "thinking");
                return;
              }
              if (data.type === "thinking" && typeof data.content === "string") {
                pushDelta(data.content, "thinking");
                return;
              }

              // 2. Direct string value, content path, or explicit type (XML tags might be here)
              if (
                typeof data.v === "string" &&
                (!data.p || data.p.includes("content") || data.p.includes("choices"))
              ) {
                // DeepSeek expert appends reasoning deltas under the THINK fragment and the
                // final answer under the RESPONSE fragment; route by the active fragment kind.
                const isReasoningDelta =
                  activeFragmentKind === "thinking" && !data.p?.includes("choices");
                pushDelta(data.v, isReasoningDelta ? "thinking" : undefined);
                return;
              }
              if (data.type === "text" && typeof data.content === "string") {
                pushDelta(data.content);
                return;
              }

              // 2.5 search results (if enabled)
              // The server surfaces searches as a SEARCH fragment with a `queries`
              // array (handled in the fragment loops below) and delivers the result
              // payloads under `p: "response/fragments/-1/results"` as an array of
              // {url,title,snippet,...} objects. Those results are consumed server-side
              // (the answer cites them as [citation:N]) — we only annotate the queries
              // and never push result objects as assistant text.
              if (
                data.type === "search_result" ||
                data.p?.includes("search_results") ||
                (data.p?.endsWith("/results") && data.p?.includes("fragments"))
              ) {
                const searchData = data.v || data.content;
                const query =
                  typeof searchData === "string"
                    ? searchData
                    : (searchData as { query?: string })?.query;
                if (query) {
                  emitResearching(query);
                }
                return;
              }

              // 2.8 data.v as direct array (DeepSeek sometimes returns this format)
              if (Array.isArray(data.v)) {
                for (const frag of data.v) {
                  if (frag.type === "THINKING" || frag.type === "reasoning" || frag.type === "THINK") {
                    activeFragmentKind = "thinking";
                    pushDelta(frag.content || "", "thinking");
                  } else if (frag.type === "SEARCH" && Array.isArray(frag.queries)) {
                    // Real server-side web search — surface each query as an annotation.
                    for (const q of frag.queries) {
                      const qtext = typeof q === "string" ? q : q?.query;
                      if (qtext) {
                        emitResearching(qtext);
                      }
                    }
                  } else if (
                    frag.p === "quasi_status" &&
                    frag.v === "FINISHED" &&
                    currentMode === "tool_call"
                  ) {
                    // DeepSeek may omit </tool_call> end tag; synthesize it on FINISHED signal
                    pushDelta(`</${currentToolName || "tool_call"}>`);
                  } else if (frag.p === "fragments" && Array.isArray(frag.v)) {
                    // BATCH wrapper: {"p":"fragments","o":"APPEND","v":[{type:"THINK",...},{type:"RESPONSE",...}]}
                    for (const inner of frag.v) {
                      if (inner?.type === "THINKING" || inner?.type === "reasoning" || inner?.type === "THINK") {
                        activeFragmentKind = "thinking";
                        pushDelta(inner.content || "", "thinking");
                      } else if (inner?.type === "RESPONSE" && inner.content) {
                        activeFragmentKind = "text";
                        pushDelta(inner.content);
                      }
                    }
                  } else if (frag.type === "RESPONSE" && frag.content) {
                    // RESPONSE fragment is the final answer; switch stream back to text.
                    activeFragmentKind = "text";
                    pushDelta(frag.content);
                  }
                }
                return;
              }

              // 3. Nested fragments (init)
              const fragments = data.v?.response?.fragments;
              if (Array.isArray(fragments)) {
                for (const frag of fragments) {
                  if (frag.type === "THINKING" || frag.type === "reasoning" || frag.type === "THINK") {
                    activeFragmentKind = "thinking";
                    pushDelta(frag.content || "", "thinking");
                  } else if (frag.type === "SEARCH" && Array.isArray(frag.queries)) {
                    // Real server-side web search — surface each query as an annotation.
                    for (const q of frag.queries) {
                      const qtext = typeof q === "string" ? q : q?.query;
                      if (qtext) {
                        emitResearching(qtext);
                      }
                    }
                  } else if (frag.type === "RESPONSE" && frag.content) {
                    // RESPONSE fragment is the final answer; switch stream back to text.
                    activeFragmentKind = "text";
                    pushDelta(frag.content);
                  }
                }
                return;
              }

              // 4. Standard OpenAI-like choices (just in case)
              const choice = data.choices?.[0];
              if (choice) {
                if (choice.delta?.reasoning_content) {
                  pushDelta(choice.delta.reasoning_content, "thinking");
                }
                if (choice.delta?.content) {
                  pushDelta(choice.delta.content);
                }
              }
            } catch {
              // Ignore partial JSON
            }
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              processLine(buffer.trim());
            }

            // Flush any remaining tag buffer
            // Flush any remaining tag buffer
            if (tagBuffer) {
              const mode = currentMode as unknown as string;
              if (mode === "thinking") {
                emitDelta("thinking", tagBuffer);
              } else if (mode === "tool_call") {
                emitDelta("toolcall", tagBuffer);
              } else {
                emitDelta("text", tagBuffer);
              }
              tagBuffer = "";
            }
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const combined = buffer + chunk;
          const parts = combined.split("\n");
          buffer = parts.pop() || ""; // Save partial line

          for (const part of parts) {
            processLine(part.trim());
          }
        }

        if (streamError) {
          // DeepSeek rejected this turn (e.g. input_exceeds_limit) after already assigning a
          // response_message_id in the `ready` event. That message id is invalid on DeepSeek's
          // side, so a retry continuing from it would fail with "invalid message id". Revert to
          // the parent we started from so the next turn starts fresh instead.
          if (parentId === undefined || parentId === null) {
            parentMessageMap.delete(sessionKey);
          } else {
            parentMessageMap.set(sessionKey, parentId);
          }
          throw new Error(`DeepSeek: ${streamError}`);
        }

        console.log(
          `[DeepseekWebStream] Stream completed. Content: ${accumulatedContent.length}, reasoning: ${accumulatedReasoning.length}, toolCalls: ${accumulatedToolCalls.length}`,
        );
        // Vision models have shown incomplete tool-call emission; log the raw content
        // verbatim for them so a failed call can be diagnosed without guessing.
        if (spec.modelType === "vision") {
          console.log(
            `[DeepseekWebStream] [vision] raw content: ${JSON.stringify(accumulatedContent)}`,
          );
        }

        // Filter internal tools from final message as per original logic,
        // but keep them in the stream parts for UI continuity.
        const INTERNAL_TOOLS = new Set<string>();
        const finalContent = contentParts.filter((part) => {
          if (part.type === "toolCall") {
            return !INTERNAL_TOOLS.has(part.name);
          }
          // Filter out empty thinking/text if they are totally empty to keep final message clean
          if (part.type === "thinking" && !part.thinking) {
            return false;
          }
          if (part.type === "text" && !part.text) {
            return false;
          }
          return true;
        });

        const assistantMessage: AssistantMessage = {
          role: "assistant",
          content: finalContent,
          stopReason: accumulatedToolCalls.length > 0 ? "toolUse" : "stop",
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
        };
        (assistantMessage as unknown as { thinking_enabled: boolean }).thinking_enabled =
          !!accumulatedReasoning;

        stream.push({
          type: "done",
          reason: assistantMessage.stopReason as "stop" | "length" | "toolUse",
          message: assistantMessage,
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
        } as AssistantMessageEvent);
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
