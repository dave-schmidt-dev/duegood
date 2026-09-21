import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanContent } from "../../scripts/check-public-tree.mjs";
import { resolveOutputPath } from "../../scripts/sync-canvas-conversations.mjs";

describe("Canvas conversation standalone entrypoint", () => {
  it("loads its Node module graph without credentials or network access", () => {
    const modulePath = fileURLToPath(new URL("../../src/canvas/conversation-sync.ts", import.meta.url));
    expect(() => execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        "globalThis.fetch = () => { throw new Error('network access is not allowed'); };",
        `const module = await import(${JSON.stringify(modulePath)});`,
        "if (typeof module.fetchCanvasConversations !== 'function') throw new Error('module graph did not load');",
      ].join("\n"),
    ], { stdio: "pipe" })).not.toThrow();
  });

  it("requires an explicit absolute Inbox output path", () => {
    expect(() => resolveOutputPath([], {})).toThrow(/output path is required/);
    expect(() => resolveOutputPath(["--output", "relative.json"], {})).toThrow(/must be absolute/);
    expect(resolveOutputPath([], { DUEGOOD_INBOX_OUTPUT: "/private/coursework/canvas-conversations.json" }))
      .toBe("/private/coursework/canvas-conversations.json");
  });

  it("keeps whitespace-delimited private token markers detectable", () => {
    const marker = ["access", "token"].join("_");
    expect(scanContent(`${marker}: abcdefghijklmnopqrstuvwxyz012345`)).toBe("explicit secret marker");
  });
});
