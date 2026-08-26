import { Type } from "@sinclair/typebox";
import {
  enablePluginInConfig,
  getScopedCredentialValue,
  readNumberParam,
  readStringParam,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { runSo360Search } from "./so360-client.js";

const So360SearchSchema = Type.Object(
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

export function createSo360WebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "so360",
    label: "360 Search",
    hint: "Free web search with no API key required; reliable Chinese results from mainland China",
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://www.so.com/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 80,
    credentialPath: "",
    inactiveSecretPaths: [],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "so360"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "so360", value),
    applySelectionConfig: (config) => enablePluginInConfig(config, "so360").config,
    createTool: (ctx) => ({
      description:
        "Search the web using 360 (so.com). Returns titles, URLs, and snippets with no API key required. Reachable from mainland China with reliable Chinese-language results.",
      parameters: So360SearchSchema,
      execute: async (args) =>
        await runSo360Search({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
        }),
    }),
  };
}
