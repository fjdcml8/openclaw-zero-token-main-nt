import { Type } from "@sinclair/typebox";
import {
  enablePluginInConfig,
  getScopedCredentialValue,
  readNumberParam,
  readStringParam,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { runBingSearch } from "./bing-client.js";

const BingSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
    region: Type.Optional(
      Type.String({
        description: "Optional Bing market/locale code such as zh-CN or en-US.",
      }),
    ),
    safeSearch: Type.Optional(
      Type.String({
        description: "SafeSearch level: strict, moderate, or off.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createBingWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "bing",
    label: "Bing Search (experimental)",
    hint: "Free web search fallback with no API key required",
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://www.bing.com/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 90,
    credentialPath: "",
    inactiveSecretPaths: [],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "bing"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "bing", value),
    applySelectionConfig: (config) => enablePluginInConfig(config, "bing").config,
    createTool: (ctx) => ({
      description:
        "Search the web using Bing. Returns titles, URLs, and snippets with no API key required. Reachable from mainland China.",
      parameters: BingSearchSchema,
      execute: async (args) =>
        await runBingSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
          region: readStringParam(args, "region"),
          safeSearch: readStringParam(args, "safeSearch") as
            | "strict"
            | "moderate"
            | "off"
            | undefined,
        }),
    }),
  };
}
