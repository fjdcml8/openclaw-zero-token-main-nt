import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSogouWebSearchProvider } from "./src/sogou-search-provider.js";

export default definePluginEntry({
  id: "sogou",
  name: "Sogou Plugin",
  description: "Bundled Sogou web search plugin",
  register(api) {
    api.registerWebSearchProvider(createSogouWebSearchProvider());
  },
});
