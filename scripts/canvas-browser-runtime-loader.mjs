import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "scripts", "canvas-browser-session-capture.mjs");
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_PDF_PAGES = 80;
const MAX_PDF_DISCOVERY_PAGES = 1000;
const MAX_PDF_TEXT = 300_000;

function renderedRows(content, { structuredRows = false } = {}) {
  if (!Array.isArray(content?.items) || content.items.length > 10_000) return null;
  if (structuredRows) {
    const positioned = [];
    let count = 0;
    for (const item of content.items) {
      if (typeof item?.str !== "string") continue;
      if (!item.str.trim()) continue;
      const x = item.transform?.[4], y = item.transform?.[5];
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) return null;
      count += item.str.length;
      if (count > MAX_PDF_TEXT) return null;
      positioned.push({ x, y, text: item.str });
    }
    positioned.sort((a, b) => b.y - a.y || a.x - b.x);
    const grouped = [];
    for (const item of positioned) {
      const row = grouped.at(-1);
      if (!row || Math.abs(row.y - item.y) > 2) grouped.push({ y: item.y, items: [{ x: item.x, text: item.text }] });
      else row.items.push({ x: item.x, text: item.text });
    }
    const rows = grouped.map((row, index) => ({ text: row.items.map((item) => item.text).join(" "), items: row.items, line: index + 1 }));
    return { text: rows.map((row) => row.text).join("\n"), rows };
  }
  const lines = [];
  let parts = [], baseline = null, count = 0;
  const flush = () => {
    if (parts.length) {
      const items = parts.sort((a, b) => a.x - b.x);
      lines.push(items.map((item) => item.text).join(" "));
    }
    parts = [];
    baseline = null;
  };
  for (const item of content.items) {
    if (typeof item?.str !== "string") continue;
    const x = item.transform?.[4], y = item.transform?.[5];
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) return null;
    count += item.str.length;
    if (count > MAX_PDF_TEXT) return null;
    if (baseline !== null && Math.abs(y - baseline) > 2) flush();
    baseline = y;
    parts.push({ x, text: item.str });
    if (item.hasEOL) flush();
  }
  flush();
  return lines.join("\n");
}

/** Fixed extraction bounds also cover a stalled PDF load or text-content request. */
export function createPdfTextExtractor({ pdfjs, timeoutMs = 20_000, heartbeatMs = 1000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000
      || !Number.isInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 1000) throw new Error("PDF_LIMIT_REJECTED");
  return async (bytes, { progress = () => {}, firstPageOnly = false, structuredRows = false } = {}) => {
    if (typeof firstPageOnly !== "boolean" || typeof structuredRows !== "boolean") return null;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_PDF_BYTES) return null;
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, verbosity: 0 });
    let timer, heartbeat, destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      try { Promise.resolve(task.destroy()).catch(() => undefined); } catch { /* Cleanup cannot expose PDF contents. */ }
    };
    try {
      progress();
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => { destroy(); resolve(null); }, timeoutMs);
        heartbeat = setInterval(() => { try { progress(); } catch { destroy(); resolve(null); } }, heartbeatMs);
      });
      const work = (async () => {
        const document = await task.promise;
        const pageLimit = firstPageOnly ? MAX_PDF_DISCOVERY_PAGES : MAX_PDF_PAGES;
        if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > pageLimit) return null;
        const pages = [];
        let characters = 0;
        const lastPage = firstPageOnly ? 1 : document.numPages;
        for (let number = 1; number <= lastPage; number += 1) {
          if (destroyed) return null;
          const content = await document.getPage(number).then((page) => page.getTextContent());
          if (destroyed) return null;
          const text = renderedRows(content, { structuredRows });
          if (text === null) return null;
          characters += typeof text === "string" ? text.length : text.text.length;
          if (characters > MAX_PDF_TEXT) return null;
          pages.push(text);
          progress();
        }
        return pages;
      })();
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      destroy();
    }
  };
}

async function fixedPdfTextExtractor() {
  const moduleUrl = pathToFileURL(path.join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs")).href;
  const pdfjs = await import(moduleUrl);
  return createPdfTextExtractor({ pdfjs });
}

/** Loads current capture source into the existing broker without closing its Chrome context. */
export async function loadCurrentCanvasCapture({ entry = ENTRY, bundle = build, loadPdfText = fixedPdfTextExtractor } = {}) {
  const result = await bundle({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  if (result.outputFiles?.length !== 1 || result.outputFiles[0].contents.length > MAX_BUNDLE_BYTES) {
    throw new Error("CAPTURE_RUNTIME_REJECTED");
  }
  const source = Buffer.from(result.outputFiles[0].contents).toString("base64");
  const runtime = await import(`data:text/javascript;base64,${source}`);
  if (typeof runtime.runCanvasCapture !== "function") throw new Error("CAPTURE_RUNTIME_REJECTED");
  const extractPdfText = await loadPdfText();
  if (typeof extractPdfText !== "function") throw new Error("CAPTURE_RUNTIME_REJECTED");
  return (options = {}) => runtime.runCanvasCapture({ ...options, extractPdfText });
}
