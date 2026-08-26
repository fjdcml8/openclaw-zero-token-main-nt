/**
 * Parse tool calls from web model text responses.
 *
 * Supports four formats (tried in order):
 * 1. Fenced: ```tool_json\n{"tool":"...","parameters":{...}}\n``` (also ```json variant)
 * 2. Bare JSON: {"tool":"...","parameters":{...}}
 * 3. XML: <tool_call>{"name":"...","arguments":{...}}</tool_call>
 * 4. Brace-aware extraction: fallback for malformed JSON
 */

export interface ParsedToolCall {
  tool: string;
  parameters: Record<string, unknown>;
}

// Fenced code block format (most reliable)
// Match both complete {"tool":...}} and truncated {"tool":...} (missing outer brace)
const FENCED_REGEX = /```(?:tool_json|json)\s*\n?\s*(\{[\s\S]*?\})\}?\s*\n?\s*```/;

// Bare JSON format — matches both "parameters" and "arguments" keys
const BARE_JSON_REGEX = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"(?:parameters|arguments)"\s*:\s*(\{[\s\S]*?\})\s*\}/;

// XML tool_call format (DeepSeek/KIMI compat) — supports both <tool_call name="x"> and bare <tool_call>.
// Also matches a <tool_call> nested inside a plural <tool_calls> wrapper (wrapper is transparent).
// The \b word boundary is required: without it "<tool_call" prefix-matches "<tool_calls>" and the
// capture would start at the wrapper open tag, truncating the inner call.
const XML_TOOL_REGEX = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call\b[^>]*>/g;

// Plural <tool_calls>...</tool_calls> wrapper carrying content directly (no inner <tool_call>).
const PLURAL_CALL_REGEX = /<tool_calls\b[^>]*>([\s\S]*?)<\/tool_calls>/g;

// Anthropic Messages API style: <invoke name="x"><parameter name="y">...</parameter></invoke>
// (DeepSeek V4 Pro sometimes emits <invoke> natively instead of <tool_call>.)
const INVOKE_REGEX = /<invoke\b[^>]*>([\s\S]*?)<\/invoke>/g;

// Anthropic-style nested parameter format: <parameter name="command">...</parameter>.
// Tolerates extra attributes after the name (DeepSeek vision emits a typed value
// annotation like <parameter name="command" string="false">...</parameter>).
const NESTED_PARAM_REGEX = /<parameter\s+name=['"]?([^'"]+)['"]?[^>]*>([\s\S]*?)<\/parameter>/gi;

// Full-width pipe variants (U+FF5C) that DeepSeek vision/reasoning models emit for
// special-token delimiters. Observed form: <｜｜DSML｜｜tool_call name="x"> instead of
// the ASCII <tool_call name="x"> — the double pipes wrap a literal "DSML" token.
// Stripping the pipes and the stray "DSML" yields the ASCII tag the regexes expect.
const FULLWIDTH_PIPE = "｜";

/**
 * Normalize full-width pipe tag delimiters to ASCII. Safe on text without any.
 * Shared by the parser, the stream middleware, and per-model streams, so every
 * site that consumes model text agrees on the same normalization.
 */
export function normalizeFullwidthTagDelimiters(text: string): string {
  if (!text || !text.includes(FULLWIDTH_PIPE)) {
    return text;
  }
  // Normalize <PREFIX?｜...｜tag ...> → <tag ...> and </PREFIX?｜...｜tag> → </tag>.
  // DeepSeek vision/reasoning models emit a model-specific prefix alongside the
  // full-width pipes, in several observed arrangements:
  //   <｜ｐｅｆ｜tool_call name="x">  →  <tool_call name="x">  (prefix inside pipes)
  //   <｜｜tool_call>                 →  <tool_call>          (no prefix)
  //   <｜DSML｜tool_call>              →  <tool_call>          ("DSML" prefix inside)
  //   <DSML｜｜tool_call name="x">    →  <tool_call name="x"> ("DSML" prefix OUTSIDE pipes)
  // The general pattern: after < or </, tolerate an optional prefix token (any
  // non-space non-'<' non-pipe chars) immediately followed by a full-width pipe,
  // then optional non-pipe non-'>' content, then an optional closing full-width
  // pipe, then the real tag name.
  // Two passes: (1) strip the optional prefix + pipe delimiters from open/close
  // tags, (2) strip any remaining bare pipe right after a tag bracket as a
  // safety net.
  let out = text.replace(/<(\/?)[^\s<｜]*[｜][^｜>]*[｜]?/g, "<$1");
  out = out.replace(/(<[/]?)[｜]+/g, "$1");
  return out;
}

/** Infer OpenClaw tool name from nested <parameter> arguments (Anthropic-style tool_call). */
function inferToolNameFromParams(params: Record<string, unknown>): string {
  if ("command" in params) return "exec";
  if ("path" in params && "content" in params) return "write";
  if ("path" in params) return "read";
  if ("query" in params) return "web_search";
  if ("url" in params) return "web_fetch";
  if ("text" in params) return "message";
  return "exec";
}

/** Parse Anthropic-style nested <parameter name="X">value</parameter> tool call content. */
function parseNestedParameterToolCall(content: string): ParsedToolCall | null {
  const params: Record<string, unknown> = {};
  let match: RegExpExecArray | null;
  NESTED_PARAM_REGEX.lastIndex = 0;
  while ((match = NESTED_PARAM_REGEX.exec(content)) !== null) {
    params[match[1].trim()] = match[2].trim();
  }
  if (Object.keys(params).length === 0) return null;
  return { tool: inferToolNameFromParams(params), parameters: params };
}

/**
 * Parse the body of an XML-style tool tag (<tool_call>, <tool_calls>, <invoke>).
 * Handles, in order: inner JSON with a tool field, nested <parameter> tags, and
 * a JSON args object paired with the tag's own name attribute.
 */
function parseXmlToolBody(body: string, tagName?: string): ParsedToolCall | null {
  const json = parseToolJson(body);
  if (json) return json;
  const nested = parseNestedParameterToolCall(body);
  if (nested) {
    if (tagName) return { tool: tagName, parameters: nested.parameters };
    return nested;
  }
  if (tagName) {
    const innerObj = parseParamsWithRepair(body);
    if (innerObj && Object.keys(innerObj).length > 0) {
      return { tool: tagName, parameters: innerObj };
    }
  }
  return null;
}

// Global version of fenced regex to match ALL tool_json blocks (handles ```tool_json and ```json)
const FENCED_GLOBAL_REGEX = /```(?:tool_json|json)\s*\n?\s*(\{[\s\S]*?\})\}?\s*\n?\s*```/g;

/** Map web tool names to OpenClaw system tool names */
function normalizeToolName(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower === "exec") return "exec";
  return name.trim();
}

/** Extract ALL tool calls from text using block splitting */
export function extractToolCalls(text: string): ParsedToolCall[] {
  text = normalizeFullwidthTagDelimiters(text);
  const results: ParsedToolCall[] = [];

  // Split by ```tool_json or ```json markers, find JSON between each pair
  const toolJsonParts = text.split(/```tool_json\b/);
  const jsonParts = text.split(/```json\b/);

  // Process tool_json fenced blocks
  for (let i = 1; i < toolJsonParts.length; i++) {
    const closeIdx = toolJsonParts[i].indexOf("```");
    if (closeIdx === -1) continue;
    const jsonStr = toolJsonParts[i].slice(0, closeIdx).trim();
    if (!jsonStr) continue;
    const parsed = parseToolJson(jsonStr);
    if (parsed) {
      parsed.tool = normalizeToolName(parsed.tool);
      results.push(parsed);
    }
  }

  // Process json fenced blocks (only if we didn't find anything via tool_json)
  if (results.length === 0) {
    for (let i = 1; i < jsonParts.length; i++) {
      const closeIdx = jsonParts[i].indexOf("```");
      if (closeIdx === -1) continue;
      const jsonStr = jsonParts[i].slice(0, closeIdx).trim();
      if (!jsonStr) continue;
      const parsed = parseToolJson(jsonStr);
      if (parsed) {
        parsed.tool = normalizeToolName(parsed.tool);
        results.push(parsed);
      }
    }
  }

  if (results.length > 0) return results;

  // XML format: extract every <tool_call>/<tool_calls>/<invoke> block. Iterate open
  // tags and close each at the EARLIER of the next closing tag or the next open tag —
  // this tolerates an unterminated call (a missing </tool_call>), which DeepSeek
  // vision/reasoning models occasionally emit when batching several calls together.
  const xmlResults = extractXmlToolCalls(text);
  if (xmlResults.length > 0) return xmlResults;

  // Fall back to single-match strategies
  const single = extractToolCall(text);
  if (single) {
    single.tool = normalizeToolName(single.tool);
    return [single];
  }
  return [];
}

/**
 * Extract every XML-formatted tool call, tolerating a missing closing tag on any
 * call by treating the next opening tag as an implicit boundary. Supports
 * <tool_call name="x">, <tool_calls name="x">, and <invoke name="x">, with bodies
 * that are either inline JSON, nested <parameter> tags, or a bare JSON object.
 */
function extractXmlToolCalls(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const openRe = /<(?:tool_call|tool_calls|invoke)\b[^>]*>/gi;
  const closeRe = /<\/(?:tool_call|tool_calls|invoke)\b[^>]*>/gi;

  // Collect positions of every open and close tag.
  const opens: { idx: number; tag: string }[] = [];
  const closes: { idx: number }[] = [];
  for (const m of text.matchAll(openRe)) opens.push({ idx: m.index!, tag: m[0] });
  for (const m of text.matchAll(closeRe)) closes.push({ idx: m.index! });

  let closePtr = 0;
  for (let i = 0; i < opens.length; i++) {
    const open = opens[i];
    const nameMatch = open.tag.match(/\bname=['"]?([^'"]+)['"]?/i);
    const tagName = nameMatch ? nameMatch[1] : "";
    const contentStart = open.idx + open.tag.length;

    while (closePtr < closes.length && closes[closePtr].idx < contentStart) closePtr++;
    const nextClose = closes[closePtr];
    const nextOpen = opens[i + 1];

    let contentEnd: number;
    if (nextClose && (!nextOpen || nextClose.idx < nextOpen.idx)) {
      contentEnd = nextClose.idx;
    } else if (nextOpen) {
      contentEnd = nextOpen.idx;
    } else {
      contentEnd = text.length;
    }

    const body = text.slice(contentStart, contentEnd).trim();
    if (!body) continue;
    const parsed = parseXmlToolBody(body, tagName || undefined);
    if (parsed) results.push(parsed);
  }
  return results;
}

export function extractToolCall(text: string): ParsedToolCall | null {
  text = normalizeFullwidthTagDelimiters(text);
  // 1. Try fenced format (```tool_json or ```json)
  const fenced = FENCED_REGEX.exec(text);
  if (fenced) {
    return parseToolJson(fenced[1]);
  }

  // 2. Try bare JSON
  const bare = BARE_JSON_REGEX.exec(text);
  if (bare) {
    try {
      const params = JSON.parse(bare[2]);
      return { tool: bare[1], parameters: params };
    } catch {
      // Fall through to other strategies
    }
  }

  // 3. Try XML format
  XML_TOOL_REGEX.lastIndex = 0; // reset — XML_TOOL_REGEX is global (/g)
  const xml = XML_TOOL_REGEX.exec(text);
  if (xml) {
    const tagName = xml[0].match(/<tool_call\b[^>]*\bname=['"]?([^'"]+)['"]?/i)?.[1];
    const parsed = parseXmlToolBody(xml[1], tagName);
    if (parsed) return parsed;
  }

  // 3b. Plural <tool_calls>...</tool_calls> wrapper carrying content directly
  // (no inner <tool_call> — the wrapper itself holds the call)
  PLURAL_CALL_REGEX.lastIndex = 0; // reset — PLURAL_CALL_REGEX is global (/g)
  const plural = PLURAL_CALL_REGEX.exec(text);
  if (plural) {
    const tagName = plural[0].match(/<tool_calls\b[^>]*\bname=['"]?([^'"]+)['"]?/i)?.[1];
    const parsed = parseXmlToolBody(plural[1], tagName);
    if (parsed) return parsed;
  }

  // 3c. Anthropic-style <invoke name="X">...</invoke> (DeepSeek V4 Pro native format)
  INVOKE_REGEX.lastIndex = 0; // INVOKE_REGEX is global (/g)
  const invoke = INVOKE_REGEX.exec(text);
  if (invoke) {
    const invokeName = invoke[0].match(/<invoke\b[^>]*\bname=['"]?([^'"]+)['"]?/i)?.[1];
    const nested = parseNestedParameterToolCall(invoke[1]);
    if (nested) {
      return { tool: (invokeName ?? nested.tool).trim(), parameters: nested.parameters };
    }
  }

  // 4. Brace-aware extraction: robust fallback for malformed JSON.
  // Handles common LLM errors: unescaped inner quotes, missing braces.
  const braceResult = extractToolCallByBraceCounting(text);
  if (braceResult) return braceResult;

  // 5. Fuzzy repair: if text looks like a truncated tool_call JSON, try to fix it.
  // Common issue: SSE stream drops the final "}" → {"tool":"exec","parameters":{"command":"ls"}
  const fuzzyMatch = text.match(
    /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*\{([^}]*)\}/,
  );
  if (fuzzyMatch) {
    // We matched inner params but might be missing outer }
    const repaired = `{"tool":"${fuzzyMatch[1]}","parameters":{${fuzzyMatch[2]}}}`;
    const result = parseToolJson(repaired);
    if (result) {
      return result;
    }
  }

  return null;
}

/**
 * Brace-aware extraction for malformed JSON.
 *
 * Instead of relying on JSON.parse for the whole object (which fails on
 * unescaped inner quotes), this extracts the tool name via regex and the
 * parameters via brace counting — no JSON.parse needed for the outer object.
 */
function extractToolCallByBraceCounting(text: string): ParsedToolCall | null {
  // Find the tool name
  const toolMatch = text.match(/"tool"\s*:\s*"([^"]*)"/);
  if (!toolMatch) return null;

  // Find the "parameters" key position
  const paramsKeyMatch = text.match(/"parameters"\s*:\s*/);
  if (!paramsKeyMatch) return null;

  const paramsStart = paramsKeyMatch.index! + paramsKeyMatch[0].length;
  const rest = text.slice(paramsStart);

  if (!rest.startsWith("{")) return null;

  // Count braces to find the end of the parameters object
  let braceCount = 0;
  let paramsEnd = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "{") braceCount++;
    else if (rest[i] === "}") {
      braceCount--;
      if (braceCount === 0) {
        paramsEnd = i + 1;
        break;
      }
    }
  }

  if (paramsEnd === -1) return null;

  const paramsJson = rest.slice(0, paramsEnd);
  const params = parseParamsWithRepair(paramsJson);
  if (!params) return null;

  return { tool: toolMatch[1], parameters: params };
}

/**
 * Parse parameters JSON with repair for common LLM errors.
 * Tries: direct parse → trailing-comma removal → unescaped-quote fix.
 */
function parseParamsWithRepair(raw: string): Record<string, unknown> | null {
  // Try direct parse
  try {
    return JSON.parse(raw);
  } catch {
    // Continue to repair strategies
  }

  // Repair 1: Remove trailing commas before } or ]
  let fixed = raw.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(fixed);
  } catch {
    // Continue
  }

  // Repair 2: Fix unescaped double quotes inside string values.
  // Common LLM error: "command":"echo "hello"" instead of "command":"echo \"hello\""
  // Strategy: find "key":" and the value string, escape any inner " chars.
  fixed = fixUnescapedQuotesInJson(fixed);
  if (fixed !== raw) {
    try {
      return JSON.parse(fixed);
    } catch {
      // Continue
    }
  }

  // Repair 3: Balance braces
  const opens = (fixed.match(/\{/g) || []).length;
  const closes = (fixed.match(/\}/g) || []).length;
  if (opens > closes) {
    fixed += "}".repeat(opens - closes);
    try {
      return JSON.parse(fixed);
    } catch {
      // Continue
    }
  }

  return null;
}

/**
 * Fix unescaped double quotes within JSON string values.
 *
 * Walks through the JSON character by character, tracking whether we're
 * inside a string value. When we find an unescaped " inside a string,
 * escapes it with a backslash.
 */
function fixUnescapedQuotesInJson(json: string): string {
  const result: string[] = [];
  let inString = false;
  let stringDelimiter = "";

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    const prev = i > 0 ? json[i - 1] : "";
    const prevPrev = i > 1 ? json[i - 2] : "";

    if (!inString) {
      result.push(ch);
      if (ch === '"' && prev !== "\\") {
        inString = true;
        stringDelimiter = '"';
      }
    } else {
      if (ch === stringDelimiter && prev !== "\\") {
        // Check if this quote closes the string or is an inner unescaped quote.
        // Look ahead: if the next non-whitespace char is : or , or } or ],
        // this is likely a closing delimiter. Otherwise it's an inner quote.
        const rest = json.slice(i + 1);
        const nextNonSpace = rest.match(/^\s*([^\s])/)?.[1];

        if (
          nextNonSpace === ":" ||
          nextNonSpace === "," ||
          nextNonSpace === "}" ||
          nextNonSpace === "]" ||
          nextNonSpace === undefined
        ) {
          // This is a legitimate closing quote
          inString = false;
          result.push(ch);
        } else {
          // This is an inner unescaped quote — escape it
          result.push("\\");
          result.push(ch);
        }
      } else if (ch === '"' && prev === "\\" && prevPrev === "\\") {
        // Double-escaped: \\" — the quote is literal, not a delimiter
        result.push(ch);
      } else {
        result.push(ch);
      }
    }
  }

  return result.join("");
}

function parseToolJson(raw: string): ParsedToolCall | null {
  let cleaned = raw.trim();
  if (!cleaned.startsWith("{")) return null;

  // Try direct parse
  try {
    const obj = JSON.parse(cleaned);
    return extractToolFromObject(obj);
  } catch {
    // Continue to repair
  }

  // Repair strategies applied in order
  const repaired = parseParamsWithRepair(cleaned);
  if (repaired) {
    // We parsed the inner params, now reconstruct the full object
    // Actually parseParamsWithRepair is for params only. For the full JSON, use repairs directly.
  }

  // Apply full-JSON repairs
  // Auto-repair: if JSON has unbalanced braces, try appending }
  const opens = (cleaned.match(/\{/g) || []).length;
  const closes = (cleaned.match(/\}/g) || []).length;
  if (opens > closes) {
    cleaned += "}".repeat(opens - closes);
  }
  // Remove trailing commas
  cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1");
  // Fix unescaped inner quotes
  cleaned = fixUnescapedQuotesInJson(cleaned);

  try {
    const obj = JSON.parse(cleaned);
    return extractToolFromObject(obj);
  } catch {
    // Last resort: brace-based extraction for the whole object
    return extractToolCallByBraceCounting(raw);
  }
}

/**
 * Shared KIMI tool call mapping: infers OpenClaw tool from tool_type/name + params.
 *
 * Covers both {"tool_type":"...","tool_input":{...}} and
 * {"tool_name":"...","parameters":{...}} variants.
 *
 * Priority: params shape > tool_type/name mapping.
 */
function mapKimiToolCall(
  toolType: string,
  params: Record<string, unknown> | undefined,
): ParsedToolCall | null {
  const p = params ?? {};

  // When KIMI gives us {"command":"python3","code":"..."}, build a shell
  // heredoc so the Python code can actually run via exec.
  // Also handles {"command":"import sqlite3\\n..."} — bare code as command.
  let normalizedParams = { ...p };
  if (typeof p.code === "string" && p.code.trim()) {
    const interpreter = typeof p.command === "string" ? p.command.trim() : "python3";
    // Only wrap when "command" is just an interpreter name (not a full shell cmd)
    if (/^(python3?|bash|sh|node|ruby|perl)$/.test(interpreter)) {
      normalizedParams = {
        ...p,
        command: `${interpreter} << 'KIMI_EOF'\n${p.code}\nKIMI_EOF`,
      };
    }
  } else if (typeof p.command === "string" && p.command.includes("\n")) {
    // Bare multi-line code as command (e.g. tool_type=python, tool_input=str).
    // Typical for KIMI when tool_input is a Python script string.
    // Wrap as python3 heredoc so exec can run it.
    const EXEC_TYPES = new Set(["python", "code", "execute", "bash", "shell", "exec", "run"]);
    if (EXEC_TYPES.has(toolType)) {
      const interpreter = toolType === "bash" || toolType === "shell" ? "bash" : "python3";
      normalizedParams = {
        ...p,
        command: `${interpreter} << 'KIMI_EOF'\n${p.command}\nKIMI_EOF`,
      };
    }
  }

  // Infer tool from params shape FIRST (more reliable than tool_type).
  const has = (key: string) => key in normalizedParams;
  let toolName: string | null = null;

  if (has("command")) {
    toolName = "exec";
  } else if (has("path") && has("content")) {
    toolName = "write";
  } else if (has("path")) {
    toolName = "read";
  } else if (has("query")) {
    toolName = "web_search";
  } else if (has("url")) {
    toolName = "web_fetch";
  } else if (has("text")) {
    toolName = "message";
  }

  // Fallback: map tool_type/name → OpenClaw tool
  if (!toolName) {
    const EXEC_TOOLS = new Set(["python", "code", "execute", "bash", "shell", "exec", "run"]);
    const SEARCH_TOOLS = new Set(["search", "web_search", "websearch"]);
    const FETCH_TOOLS = new Set(["fetch", "web_fetch", "webfetch", "url", "web"]);
    const READ_TOOLS = new Set(["file", "read", "read_file", "open"]);
    const WRITE_TOOLS = new Set(["write", "write_file", "create", "save"]);
    const MESSAGE_TOOLS = new Set(["send", "message", "notify", "msg"]);

    if (EXEC_TOOLS.has(toolType)) toolName = "exec";
    else if (SEARCH_TOOLS.has(toolType)) toolName = "web_search";
    else if (FETCH_TOOLS.has(toolType)) toolName = "web_fetch";
    else if (READ_TOOLS.has(toolType)) toolName = "read";
    else if (WRITE_TOOLS.has(toolType)) toolName = "write";
    else if (MESSAGE_TOOLS.has(toolType)) toolName = "message";
    else toolName = toolType; // unknown — pass through
  }

  return { tool: toolName, parameters: normalizedParams };
}

function extractToolFromObject(obj: Record<string, unknown>): ParsedToolCall | null {
  // ComfyUI LLM Party format: {"tool":"name","parameters":{...}}
  // KIMI format: {"tool":"name","arguments":{...}}
  if (obj.tool && typeof obj.tool === "string") {
    return {
      tool: obj.tool,
      parameters:
        (obj.arguments as Record<string, unknown>) ??
        (obj.parameters as Record<string, unknown>) ??
        {},
    };
  }

  // OpenAI format: {"name":"...","arguments":{...}}
  if (obj.name && typeof obj.name === "string") {
    return {
      tool: obj.name,
      parameters: (obj.arguments as Record<string, unknown>) ?? {},
    };
  }

  // KIMI v2 format: {"tool_name":"python","parameters":{"command":"python3","code":"..."}}
  // Some KIMI responses use "tool_name" instead of "tool_type".
  if (obj.tool_name && typeof obj.tool_name === "string") {
    const rawParams = obj.parameters as Record<string, unknown> | undefined;
    const toolType = obj.tool_name.toLowerCase();
    const mapped = mapKimiToolCall(toolType, rawParams);
    if (mapped) return mapped;
  }

  // KIMI native format: {"tool_type":"...","tool_input":"..."|{...}}
  // KIMI's tool_type is unreliable — the model may call "file" but pass a
  // shell command, or use "python" with a URL.
  if (obj.tool_type && typeof obj.tool_type === "string") {
    const rawInput = obj.tool_input;
    const toolType = obj.tool_type.toLowerCase();

    // Normalize tool_input → parameters
    let params: Record<string, unknown>;
    if (typeof rawInput === "string") {
      params = { command: rawInput };
    } else if (typeof rawInput === "object" && rawInput !== null) {
      params = rawInput as Record<string, unknown>;
    } else {
      params = {};
    }

    const mapped = mapKimiToolCall(toolType, params);
    if (mapped) return mapped;
  }

  return null;
}

/** KIMI native formats: {"tool_type":"...","tool_input":...} and {"tool_name":"...","parameters":...} */
const KIMI_NATIVE_REGEX = /\{\s*"tool_(?:type|name)"\s*:\s*"[^"]+"\s*,\s*"(?:tool_input|parameters)"\s*:/;

/** Check if text contains a tool call (quick check without full parsing) */
export function hasToolCall(text: string): boolean {
  text = normalizeFullwidthTagDelimiters(text);
  XML_TOOL_REGEX.lastIndex = 0; // reset — XML_TOOL_REGEX is global (/g)
  INVOKE_REGEX.lastIndex = 0; // reset — INVOKE_REGEX is global (/g)
  PLURAL_CALL_REGEX.lastIndex = 0; // reset — PLURAL_CALL_REGEX is global (/g)
  return FENCED_REGEX.test(text) || BARE_JSON_REGEX.test(text) ||
    XML_TOOL_REGEX.test(text) || INVOKE_REGEX.test(text) ||
    PLURAL_CALL_REGEX.test(text) || KIMI_NATIVE_REGEX.test(text);
}
