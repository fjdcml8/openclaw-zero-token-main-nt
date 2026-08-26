export const CHAT_ATTACHMENT_ACCEPT =
  "image/*,.pdf,.doc,.docx,.txt,.md,.csv,.rtf,.xls,.xlsx,.ppt,.pptx";

// Document MIME prefixes/types accepted by the chat attachment button. DeepSeek
// web (and other web AIs) read these natively when forwarded via ref_file_ids,
// so documents are uploaded unmodified rather than text-extracted.
const DOCUMENT_MIME_PATTERNS: Array<string | RegExp> = [
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  /^text\//,
];

const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".txt",
  ".md",
  ".csv",
  ".rtf",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
]);

export function isDocumentChatAttachmentMimeType(
  mimeType: string | null | undefined,
): boolean {
  if (typeof mimeType !== "string" || !mimeType) {
    return false;
  }
  const m = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return DOCUMENT_MIME_PATTERNS.some((pattern) =>
    typeof pattern === "string" ? m === pattern : pattern.test(m),
  );
}

function hasDocumentExtension(fileName?: string): boolean {
  if (!fileName) {
    return false;
  }
  const ext = fileName.split(".").pop()?.toLowerCase();
  return !!ext && DOCUMENT_EXTENSIONS.has(`.${ext}`);
}

export function isSupportedChatAttachmentMimeType(
  mimeType: string | null | undefined,
  fileName?: string,
): boolean {
  if (typeof mimeType === "string" && mimeType.startsWith("image/")) {
    return true;
  }
  return isDocumentChatAttachmentMimeType(mimeType) || hasDocumentExtension(fileName);
}
