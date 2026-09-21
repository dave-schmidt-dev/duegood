#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStoredConversationSnapshot, fetchCanvasConversations, sanitizeStoredConversations } from "../src/canvas/conversation-sync.ts";

export function resolveOutputPath(argv = process.argv.slice(2), env = process.env) {
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      if (output !== undefined || argv[index + 1] === undefined) {
        throw new Error("Inbox output path is required exactly once: --output /absolute/path");
      }
      output = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  const configured = output ?? env.DUEGOOD_INBOX_OUTPUT;
  if (!configured) {
    throw new Error("Inbox output path is required: pass --output /absolute/path or set DUEGOOD_INBOX_OUTPUT");
  }
  if (!path.isAbsolute(configured)) {
    throw new Error("Inbox output path must be absolute");
  }
  return path.normalize(configured);
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const outputPath = resolveOutputPath(argv, env);
  const token = env.CANVAS_API_TOKEN;
  if (!token) throw new Error("CANVAS_API_TOKEN is required through the fixed BWS consumer");

  let previous = [];
  try {
    const document = JSON.parse(await readFile(outputPath, "utf8"));
    previous = sanitizeStoredConversations(document.conversations);
  } catch {
    // First sync: no prior private inbox snapshot exists.
  }

  const result = await fetchCanvasConversations({
    origin: "https://marymount.instructure.com",
    token,
    onStatus: (message) => process.stderr.write(`canvas-inbox: ${message}\n`),
  });
  const snapshot = buildStoredConversationSnapshot(previous, result);
  const output = Buffer.from(`${JSON.stringify({ schema: 1, ...snapshot }, null, 2)}\n`);
  const temporary = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(output);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, outputPath);
  } finally {
    if (handle !== undefined) await handle.close();
    await rm(temporary, { force: true });
  }
  process.stderr.write(`canvas-inbox: ${snapshot.complete ? "complete" : "partial"}; ${String(snapshot.conversations.length)} threads; ${String(snapshot.rejected)} rejected\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await run();
}
