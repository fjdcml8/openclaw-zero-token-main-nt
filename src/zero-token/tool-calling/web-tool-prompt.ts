/**
 * Per-model tool calling prompt templates.
 *
 * Reference:
 * - Paper: https://arxiv.org/html/2407.04997v1
 * - ComfyUI LLM Party: https://github.com/heshengtao/comfyui_LLM_party
 */

import path from "node:path";
import { resolveRequiredOsHomeDir } from "../../infra/home-dir.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { toolDefsJson } from "./web-tool-defs.js";

const TOOL_DEFS = toolDefsJson();

// Example-based teaching (key insight from arXiv:2407.04997 and ComfyUI LLM Party):
// A trivial example teaches the model the output format without confusing it with real tools.
const TOOL_EXAMPLE = `Example: to add 1 to number 5, return:
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
(plus_one is just an example, not a real tool)`;

/** Resolve the CAD template project path (project-root/python3/cad_draw_template.py).
 *  Uses the openclaw package root so it works on any machine, regardless of username. */
function resolveCadTemplatePath(): string {
  const pkgRoot =
    resolveOpenClawPackageRootSync({
      moduleUrl:
        typeof import.meta.url === "string" ? import.meta.url : undefined,
    }) ?? process.cwd();
  return path.join(pkgRoot, "python3", "cad_draw_template.py");
}

/** Resolve the CAD workspace script path (~/.openclaw-zero/workspace/cad_draw.py).
 *  Honors OPENCLAW_HOME via the project's own home-dir resolution. */
function resolveCadWorkspacePath(): string {
  return path.join(resolveRequiredOsHomeDir(), ".openclaw-zero", "workspace", "cad_draw.py");
}

/** Build the CAD instruction using machine-independent paths.
 *  Kept as a function so the home dir / project root are resolved at call time —
 *  a module-level constant would bake in the first user's absolute paths. */
function buildCadInstruction(): string {
  const templatePath = resolveCadTemplatePath();
  const workspacePath = resolveCadWorkspacePath();
  return `
【CAD 绘图】仅当用户明确说 "CAD绘图 / 画图 / 图纸 / DXF" 时才执行；未明确要求时忽略本段，正常对话。
1. 用 read 查看模板 ${templatePath}（可选）
2. 用 write 把 Python3 脚本(ezdxf库)写到 ${workspacePath}
3. 用 exec 运行: python3 ${workspacePath}
4. 脚本会自动把 .dxf 保存到桌面，完成后告诉用户文件路径`;
}

const EN_TEMPLATE = `Tools: ${TOOL_DEFS}

${TOOL_EXAMPLE}

Your actual tools are listed above. To use one, reply ONLY with the tool_json block.
No tool needed? Answer directly.

`;

const EN_STRICT_TEMPLATE = `Tools: ${TOOL_DEFS}

${TOOL_EXAMPLE}

Your actual tools are listed above. To use one, reply ONLY with the tool_json block. No extra text.
No tool needed? Answer directly.

`;

const CN_TEMPLATE = `可用工具: ${TOOL_DEFS}

使用工具时，输出格式如下（用三个反引号包裹tool_json代码块）:
\`\`\`tool_json
{"tool":"工具名","parameters":{"参数名":"参数值"}}
\`\`\`

多步操作: 连续输出多个tool_json块。例如:
\`\`\`tool_json
{"tool":"write","parameters":{"path":"/path/to/file.py","content":"print('hello')"}}
\`\`\`
\`\`\`tool_json
{"tool":"exec","parameters":{"command":"python3 /path/to/file.py"}}
\`\`\`

注意: JSON中字符串内的双引号必须转义为\\"，例如命令中的引号要写成\\"。
需要工具时只回复tool_json块，不要其他文字。多个工具连续输出，全部执行完再总结。

`;

/** KIMI-specific format — KIMI naturally uses {"tool":"name","arguments":{...}} inside <tool_call> tags.
 *  We tell it to use the fenced ```tool_json format which our parser handles best. */
const KIMI_TEMPLATE = `可用工具: ${TOOL_DEFS}

使用工具时，用以下格式输出（每个工具一个代码块，可以连续多个）:
\`\`\`tool_json
{"tool":"工具名","parameters":{"参数名":"参数值"}}
\`\`\`

示例-写文件并执行:
\`\`\`tool_json
{"tool":"write","parameters":{"path":"/path/to/file.py","content":"print('hello')"}}
\`\`\`
\`\`\`tool_json
{"tool":"exec","parameters":{"command":"python3 /path/to/file.py"}}
\`\`\`

只回复tool_json块，不需要其他文字。不需要工具时直接回答。
`;

/** XML tool_call format for DeepSeek (matches conversation history format).
 *  The DeepSeek stream natively parses <tool_call> tags, so we align the
 *  prompt with the stream's own output format to avoid confusing the model. */
const CN_XML_TEMPLATE = `可用工具: ${TOOL_DEFS}

使用工具时，输出格式如下:
<tool_call name="工具名">{"参数名":"参数值"}</tool_call>

多步操作: 连续输出多个tool_call标签。例如:
<tool_call name="write">{"path":"/path/to/file.py","content":"print('hello')"}</tool_call>
<tool_call name="exec">{"command":"python3 /path/to/file.py"}</tool_call>

注意: JSON中字符串内的双引号必须转义为\\"，例如命令中的引号要写成\\"。
需要工具时只回复tool_call标签，不要其他文字。不需要工具时直接回答。

`;

/** No web models skip prompt injection — web interfaces don't pass native tools.
 *  Even DeepSeek/Claude/GLM need prompt injection when accessed via browser. */
const NATIVE_TOOL_MODELS = new Set<string>();

/** Models excluded from tool calling entirely */
const EXCLUDED_MODELS = new Set(["perplexity-web", "doubao-web"]);

/** KIMI models — use `arguments` key in tool_json format (matches KIMI's native output) */
const KIMI_MODELS = new Set(["kimi-web"]);

/** Chinese-language models (use ```tool_json format) */
const CN_MODELS = new Set([
  "doubao-web",
  "qwen-cn-web",
  "glm-web",
  "xiaomimo-web",
]);

/** Models that use XML <tool_call> format (matches their stream's native parser) */
const XML_MODELS = new Set(["deepseek-web"]);

/** Models that tend to add extra text after JSON */
const STRICT_MODELS = new Set(["chatgpt-web"]);

export function shouldInjectToolPrompt(api: string): boolean {
  return !NATIVE_TOOL_MODELS.has(api) && !EXCLUDED_MODELS.has(api);
}

export function getToolPrompt(api: string): string {
  const cadInstruction = buildCadInstruction();
  if (STRICT_MODELS.has(api)) {
    return EN_STRICT_TEMPLATE;
  }
  if (XML_MODELS.has(api)) {
    return CN_XML_TEMPLATE + cadInstruction + "\n";
  }
  if (KIMI_MODELS.has(api)) {
    return KIMI_TEMPLATE;
  }
  if (CN_MODELS.has(api)) {
    return CN_TEMPLATE + cadInstruction + "\n";
  }
  return EN_TEMPLATE;
}

/** Format tool result for feedback to the model */
export function formatToolResult(toolName: string, result: string): string {
  return `Tool ${toolName} returned: ${result}\nPlease continue answering based on this result.`;
}
