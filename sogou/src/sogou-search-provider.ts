import { Type } from "@sinclair/typebox";
import {
  enablePluginInConfig,
  getScopedCredentialValue,
  readNumberParam,
  readStringParam,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { runSogouSearch } from "./sogou-client.js";

const SogouSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createSogouWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "sogou",
    label: "Sogou Search",
    hint: "Free web search with no API key required; reliable Chinese results from mainland China",
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://www.sogou.com/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 80,
    credentialPath: "",
    inactiveSecretPaths: [],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "sogou"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "sogou", value),
    applySelectionConfig: (config) => enablePluginInConfig(config, "sogou").config,
    createTool: (ctx) => ({
      description:
        "Search the web using Sogou. Returns titles, URLs, and snippets with no API key required. Reachable from mainland China with reliable Chinese-language results.",
      parameters: SogouSearchSchema,
      execute: async (args) =>
        await runSogouSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
        }),
    }),
  };
}
