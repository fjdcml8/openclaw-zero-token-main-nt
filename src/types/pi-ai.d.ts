import "@mariozechner/pi-ai";

declare module "@mariozechner/pi-ai" {
  // OpenClaw web streams support document uploads (e.g. DeepSeek web `ref_file_ids`).
  // pi-ai's `Model.input` only knows `"text" | "image"`; extending it lets the
  // middleware gate document preservation on `model.input.includes("document")`.
  interface Model<TApi extends import("@mariozechner/pi-ai").Api = import("@mariozechner/pi-ai").Api> {
    input: ("text" | "image" | "document")[];
  }
}
