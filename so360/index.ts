import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSo360WebSearchProvider } from "./src/so360-search-provider.js";

export default definePluginEntry({
  id: "so360",
  name: "360 Search Plugin",
  description: "Bundled 360 (so.com) web search plugin",
  register(api) {
    api.registerWebSearchProvider(createSo360WebSearchProvider());
  },
});
