import { describe, expect, it } from "vitest";
import { extractToolCalls, hasToolCall } from "./web-tool-parser.js";

describe("web-tool-parser DSML format (prefix outside full-width pipes)", () => {
  it("parses <DSML｜｜tool_call name=\"x\"> JSON-body calls", () => {
    const text = `<DSML｜｜tool_call name="read">{"path":"/a.md"}</DSML｜｜tool_call>`;
    const calls = extractToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ tool: "read", parameters: { path: "/a.md" } });
  });

  it("parses multiple DSML calls including an unterminated first call", () => {
    // First block has no closing tag — the extractor must use the next open tag
    // as the boundary.
    const text = `<DSML｜｜tool_call name="read">{"path":"/a.md"}
<DSML｜｜tool_call name="exec">{"command":"ls"}</DSML｜｜tool_call>`;
    const calls = extractToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ tool: "read", parameters: { path: "/a.md" } });
    expect(calls[1]).toEqual({ tool: "exec", parameters: { command: "ls" } });
  });

  it("normalizes closing tags too", () => {
    const text = `x<DSML｜｜tool_call name="exec">{"command":"pwd"}</DSML｜｜tool_call>y`;
    expect(extractToolCalls(text)).toEqual([
      { tool: "exec", parameters: { command: "pwd" } },
    ]);
  });

  it("still handles the older prefix-inside forms", () => {
    expect(extractToolCalls(`<｜｜tool_call>{"tool":"read","parameters":{"path":"/a"}}<｜｜tool_call>`)).toEqual([
      { tool: "read", parameters: { path: "/a" } },
    ]);
    expect(extractToolCalls(`<｜DSML｜tool_call>{"tool":"exec","parameters":{"command":"ls"}}</｜DSML｜tool_call>`)).toEqual([
      { tool: "exec", parameters: { command: "ls" } },
    ]);
  });

  it("hasToolCall detects the DSML form", () => {
    expect(hasToolCall(`<DSML｜｜tool_call name="read">{"path":"/a.md"}</DSML｜｜tool_call>`)).toBe(true);
    expect(hasToolCall("纯文本，没有工具调用")).toBe(false);
  });
});
