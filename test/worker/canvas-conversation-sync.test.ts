import { describe, expect, it } from "vitest";
import { buildStoredConversationSnapshot, fetchCanvasConversations, sanitizeStoredConversations } from "../../src/canvas/conversation-sync";
import type { NormalizedConversation } from "../../src/canvas/conversations";

function detail(id: number): Record<string, unknown> {
  return { id, subject: `Thread ${String(id)}`, context_name: "SYN-101", workflow_state: id === 1 ? "unread" : "read", participants: [{ id: 9, name: "Instructor" }], messages: [{ body: "Synthetic message", created_at: `2030-01-0${String(id)}T00:00:00Z`, attachments: [] }] };
}

describe("Canvas conversation sync", () => {
  it("paginates only Canvas and fetches details without marking threads read", async () => {
    const urls: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input); urls.push(url);
      if (url.includes("scope=inbox")) return new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), { status: 200, headers: { "Content-Type": "application/json" } });
      const id = url.includes("/1?") ? 1 : 2;
      return new Response(JSON.stringify(detail(id)), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const result = await fetchCanvasConversations({ origin: "https://canvas.example.invalid", token: "synthetic", fetcher: fetcher as typeof fetch });
    expect(result.complete).toBe(true);
    expect(result.conversations).toHaveLength(2);
    expect(urls.filter((url) => url.includes("auto_mark_as_read=false"))).toHaveLength(2);
  });

  it("rejects cross-origin pagination before sending another request", async () => {
    const fetcher = async () => new Response("[]", { status: 200, headers: { Link: '<https://attacker.invalid/api/v1/conversations?page=2>; rel="next"' } });
    await expect(fetchCanvasConversations({ origin: "https://canvas.example.invalid", token: "synthetic", fetcher: fetcher as typeof fetch })).rejects.toThrow("unsafe");
  });

  it("marks a full page at the page cap incomplete without proof of exhaustion", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("scope=inbox")) {
        return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const id = Number(new URL(url).pathname.split("/").at(-1));
      return new Response(JSON.stringify({ id, subject: `Thread ${String(id)}`, context_name: "SYN-101", workflow_state: "read", participants: [{ id: 9, name: "Instructor" }], messages: [{ body: "Synthetic message", created_at: "2030-01-01T00:00:00Z", attachments: [] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const result = await fetchCanvasConversations({ origin: "https://canvas.example.invalid", token: "synthetic", fetcher: fetcher as typeof fetch, maxPages: 1, maxConversations: 200 });
    expect(result.conversations).toHaveLength(100);
    expect(result.complete).toBe(false);
  });

  it("keeps prior threads and reports no removals after a partial fetch", () => {
    const prior: NormalizedConversation = { canvasConversationId: "old", contextLabel: null, subject: "Old", participants: [], latestMessagePreview: null, latestMessageAt: null, unread: false, starred: false, messageCount: 1, attachments: [] };
    const snapshot = buildStoredConversationSnapshot([prior], { complete: false, rejected: 1, conversations: [] }, new Date("2030-01-01T00:00:00Z"));
    expect(snapshot.conversations).toEqual([prior]);
    expect(snapshot.changes.removed).toEqual([]);
  });

  it("drops unrecognized fields while loading a prior private snapshot", () => {
    const stored = sanitizeStoredConversations([{ ...detail(1), canvasConversationId: "1", contextLabel: "SYN-101", latestMessagePreview: "Preview", latestMessageAt: "2030-01-01T00:00:00Z", unread: true, starred: false, messageCount: 1, participants: [{ canvasUserId: "9", name: "Instructor", avatar_url: "https://secret.invalid" }], attachments: [], url: "https://secret.invalid" }]);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("secret.invalid");
    expect(JSON.stringify(stored)).not.toContain("url");
  });
});
