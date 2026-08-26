import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantMessageEvent, TextContent } from "@mariozechner/pi-ai";
import { createDeepseekWebStreamFn } from "./deepseek-web-stream.js";

/**
 * Regression test for deepseek-v4-flash-vision-exp (deepseek-web):
 *
 * The vision model emits a <tool_call> whose body is raw JSON args followed by a
 * stray </parameter> (no matching <parameter name="X"> open tag), e.g.
 *   <tool_call name="exec">{"command":"..."}</parameter>
 *   </invoke>
 *   </tool_call>
 *
 * Previously the stream parser treated that stray </parameter> as assistant text
 * because `currentParamName` was empty, so the tool block was only half-hidden:
 * the visible reply ended with `</parameter>。`. Structural tags inside a
 * tool_call block must never leak into the visible text.
 */

// The exact payload shape reported for this model.
const TOOL_CALL_CONTENT =
  "好的，我来把这个温度保险丝的信息加入知识库。先查询一下当前数据库情况，然后写入。\n\n" +
  '<tool_call name="exec">{"command":"cd /Users/cml/knowledge-base && sqlite3 knowledge.db \\"SELECT COUNT(*) FROM entries;\\" && sqlite3 knowledge.db \\"SELECT MAX(id) FROM entries;\\""}</parameter>\n' +
  "</invoke>\n" +
  "</tool_call>。";

const PLAIN_CONTENT = "好的，已经处理完成。";

// The stream constructs the client internally (`new DeepSeekWebClient(options)`),
// so replace the class with a mock whose chatCompletions() returns a canned SSE
// body. The body's content is swapped per test through the exported `__mock`.
// The factory must not reference module-level consts (they live in the TDZ when
// the mocked module is first imported), hence the holder starts empty and is
// always populated by runStream() before the stream is driven.
vi.mock("../providers/deepseek-web-client.js", () => {
  const encoder = new TextEncoder();
  const sseStream = (dataLines: string[]): ReadableStream<Uint8Array> => {
    const body = dataLines.map((l) => `${l}\n`).join("");
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
  };
  const sseFor = (content: string): ReadableStream<Uint8Array> =>
    sseStream([
      "event: ready",
      `data: ${JSON.stringify({ type: "ready", response_message_id: 12345 })}`,
      "",
      `data: ${JSON.stringify({ type: "text", content })}`,
      "data: [DONE]",
    ]);

  const holder: { content: string } = { content: "" };

  class MockDeepSeekWebClient {
    constructor(_options: unknown) {}
    async init() {}
    async createChatSession() {
      return { chat_session_id: "mock-session-id" };
    }
    async createPowChallenge() {
      return { challenge: "mock", signature: "", target_path: "" };
    }
    async solvePow() {
      return 0;
    }
    async uploadFile() {
      return "mock-file-id";
    }
    async forkFileTask() {
      return "mock-forked-file-id";
    }
    async chatCompletions() {
      return sseFor(holder.content);
    }
  }

  return { DeepSeekWebClient: MockDeepSeekWebClient, __mock: holder };
});

// vi.mock swaps the module at runtime; the real module has no `__mock` export,
// so reach the mock factory's holder through the namespace with a cast (type-safe
// against the real module's declarations).
import * as clientMod from "../providers/deepseek-web-client.js";
const __mock = (clientMod as unknown as { __mock: { content: string } }).__mock;

afterEach(() => {
  __mock.content = TOOL_CALL_CONTENT;
});

async function runStream(content: string, sessionId = "test-session"): Promise<AssistantMessageEvent[]> {
  __mock.content = content;
  const streamFn = createDeepseekWebStreamFn("{}");
  const events: AssistantMessageEvent[] = [];
  const model = {
    id: "deepseek-v4-flash-vision-exp",
    api: "deepseek-web",
    provider: "deepseek",
    name: "deepseek-v4-flash-vision-exp",
    displayName: "deepseek-v4-flash-vision-exp",
  };
  const context = {
    sessionId,
    messages: [{ role: "user", content: "把温度保险丝信息加入知识库" }],
  };
  const stream = streamFn(
    model as never,
    context as never,
    {} as never,
  ) as unknown as AsyncIterable<AssistantMessageEvent>;
  for await (const ev of stream) {
    events.push(ev);
  }
  return events;
}

function doneMessage(events: AssistantMessageEvent[]) {
  return events.find((e) => e.type === "done");
}

describe("deepseek-web stream tool-block hiding (vision model)", () => {
  it("hides the tool block completely — no stray </parameter> leaks into text", async () => {
    const events = await runStream(TOOL_CALL_CONTENT);
    const done = doneMessage(events);
    expect(done).toBeDefined();
    if (!done) return;
    if (done.type !== "done") return;

    const text = done.message.content
      .filter((p) => p.type === "text")
      .map((p) => (p as TextContent).text)
      .join("\n");
    const toolCalls = done.message.content.filter((p) => p.type === "toolCall");

    // Lead-in preserved, but no tool-block XML fragment may appear.
    expect(text).toContain("好的，我来把这个温度保险丝的信息加入知识库");
    expect(text).not.toContain("</parameter>");
    expect(text).not.toContain("<parameter");
    expect(text).not.toContain("<tool_call");
    expect(text).not.toContain("</invoke>");
    expect(text).not.toContain("</tool_call>");

    // The call itself must be parsed into a toolCall part.
    expect(toolCalls).toHaveLength(1);
    const tc = toolCalls[0];
    expect(tc.name).toBe("exec");
    expect(String(tc.arguments.command)).toContain("sqlite3 knowledge.db");

    // The tool block must also not appear across the streamed deltas (no half-emitted tag).
    const allText = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(allText).not.toContain("</parameter>");
    expect(allText).not.toContain("<tool_call");
  });

  it("still streams plain text unchanged when there is no tool block", async () => {
    const events = await runStream(PLAIN_CONTENT, "test-session-plain");
    const done = doneMessage(events);
    expect(done).toBeDefined();
    if (!done) return;
    if (done.type !== "done") return;

    const text = done.message.content
      .filter((p) => p.type === "text")
      .map((p) => (p as TextContent).text)
      .join("\n");
    expect(text).toBe(PLAIN_CONTENT);
    expect(done.message.content.filter((p) => p.type === "toolCall")).toHaveLength(0);
  });
});
