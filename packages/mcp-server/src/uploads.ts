import { createReadStream, promises as fsp } from "node:fs";
import { basename } from "node:path";
import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, WireMethodName } from "@remora/protocol";
import type { RemoraHub } from "./hub.js";

export interface UploadTarget {
  tabId?: number;
  ref?: string;
  selector?: string;
}

export interface PreparedFile {
  fileName: string;
  mimeType: string;
  totalBytes: number;
  chunks: number;
  data: Buffer;
}

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function guessMimeType(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Read a local file into memory, enforcing the size cap. */
export async function prepareFile(filePath: string): Promise<PreparedFile> {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw toolError(`file not found: ${filePath}`);
  }
  if (stat.size <= 0) {
    throw toolError(`file is empty: ${filePath}`);
  }
  if (stat.size > UPLOAD_MAX_BYTES) {
    throw toolError(
      `file too large: ${stat.size} bytes (max ${UPLOAD_MAX_BYTES}). Split the file or upload a smaller one.`,
    );
  }
  const data = await readFile(filePath);
  return {
    fileName: basename(filePath),
    mimeType: guessMimeType(filePath),
    totalBytes: data.length,
    chunks: Math.max(1, Math.ceil(data.length / UPLOAD_CHUNK_BYTES)),
    data,
  };
}

function readFile(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    const stream = createReadStream(filePath);
    stream.on("data", (c) => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(parts)));
  });
}

/**
 * Push one file to the extension over the chunked pipeline, then either
 * inject it into a file input (`inject`) or drop it on a zone (`drop`).
 * Returns the extension-side result of the final step.
 */
export async function transferFile(
  hub: RemoraHub,
  file: PreparedFile,
  target: UploadTarget,
  mode: "inject" | "drop",
): Promise<unknown> {
  const begin = (await hub.request("upload.begin", {
    tabId: target.tabId,
    fileName: file.fileName,
    mimeType: file.mimeType,
    totalBytes: file.totalBytes,
    chunks: file.chunks,
  })) as { transferId: string };

  const transferId = begin.transferId;
  try {
    for (let i = 0; i < file.chunks; i++) {
      const slice = file.data.subarray(i * UPLOAD_CHUNK_BYTES, (i + 1) * UPLOAD_CHUNK_BYTES);
      await hub.request("upload.chunk", {
        transferId,
        index: i,
        base64: slice.toString("base64"),
      });
    }
    const method: WireMethodName = mode === "inject" ? "upload.inject" : "upload.drop";
    return await hub.request(method, {
      transferId,
      ref: target.ref,
      selector: target.selector,
    });
  } catch (err) {
    try {
      await hub.request("upload.abort", { transferId });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/** Error shaped for MCP tool results (message shown to the agent). */
export function toolError(message: string): Error {
  const err = new Error(message) as Error & { isToolError: true };
  err.isToolError = true;
  return err;
}
