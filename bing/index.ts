import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createBingWebSearchProvider } from "./src/bing-search-provider.js";

export default definePluginEntry({
  id: "bing",
  name: "Bing Plugin",
  description: "Bundled Bing web search plugin",
  register(api) {
    api.registerWebSearchProvider(createBingWebSearchProvider());
  },
});
