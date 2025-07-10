// file.js – Utility for working with filenames and content types

const mimeTypes = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml"
};

export function getMimeType(filename = "") {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return mimeTypes[ext] || "application/octet-stream";
}

export function getFileExtension(contentType = "") {
  const found = Object.entries(mimeTypes).find(([, type]) => type === contentType);
  return found?.[0] || "bin";
}

export function sanitizeFilename(filename = "") {
  return filename
    .replace(/[^a-z0-9\-_\.]/gi, "_") // Replace unsafe characters
    .toLowerCase()
    .substring(0, 64); // Limit length
}
