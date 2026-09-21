import { describe, expect, it } from "vitest";
import {
  diffConversationSnapshots,
  normalizeCanvasConversation,
  type NormalizedConversation,
} from "../../src/canvas/conversations";

function rawConversation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 71,
    context_name: "IT 530 - Foundations",
    subject: "Week 4 reminder",
    workflow_state: "unread",
    starred: true,
    message_count: 2,
    participants: [
      { id: 10, name: "Professor Rivera", avatar_url: "https://canvas.invalid/avatar?token=secret" },
      { id: 20, name: "Student" },
    ],
    last_message: '<p>Please review <a href="https://canvas.invalid/file?access_token=secret">the rubric</a>.</p>',
    last_message_at: "2026-09-20T14:30:00-04:00",
    messages: [
      {
        id: 100,
        body: "Earlier message",
        created_at: "2026-09-19T13:00:00Z",
        attachments: [],
      },
      {
        id: 101,
        body: "Please review the rubric",
        created_at: "2026-09-20T18:30:00Z",
        attachments: [
          {
            id: 500,
            display_name: "rubric.pdf",
            "content-type": "application/pdf",
            size: 4096,
            url: "https://canvas.invalid/download?access_token=secret",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function normalize(raw: Record<string, unknown>): NormalizedConversation {
  const result = normalizeCanvasConversation(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected normalized conversation");
  return result.conversation;
}

describe("normalizeCanvasConversation", () => {
  it("projects only the bounded fields needed by the read-only inbox", () => {
    const result = normalizeCanvasConversation(rawConversation());
    expect(result).toMatchObject({
      ok: true,
      conversation: {
        canvasConversationId: "71",
        contextLabel: "IT 530 - Foundations",
        subject: "Week 4 reminder",
        participants: [
          { canvasUserId: "10", name: "Professor Rivera" },
          { canvasUserId: "20", name: "Student" },
        ],
        latestMessagePreview: "Please review the rubric .",
        latestMessageAt: "2026-09-20T18:30:00.000Z",
        unread: true,
        starred: true,
        messageCount: 2,
        historyComplete: true,
        safetyTruncated: false,
        messages: [
          { canvasMessageId: "100", author: "Canvas participant", createdAt: "2026-09-19T13:00:00.000Z", body: "Earlier message", bodyTruncated: false, attachments: [] },
          { canvasMessageId: "101", author: "Canvas participant", createdAt: "2026-09-20T18:30:00.000Z", body: "Please review the rubric", bodyTruncated: false, attachments: [{ name: "rubric.pdf", contentType: "application/pdf", sizeBytes: 4096 }] },
        ],
        attachments: [{ name: "rubric.pdf", contentType: "application/pdf", sizeBytes: 4096 }],
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("canvas.invalid");
    expect(serialized).not.toContain("avatar_url");
    expect(serialized).not.toContain('"url"');
  });

  it("truncates long display strings and redacts token-bearing links in previews", () => {
    const conversation = normalize(
      rawConversation({
        subject: "s".repeat(400),
        last_message: "Open https://canvas.invalid/path?token=secret then token=also-secret",
      }),
    );
    expect(conversation.subject).toHaveLength(240);
    expect(conversation.subject.endsWith("…")).toBe(true);
    expect(conversation.latestMessagePreview).toBe("Open https://canvas.invalid/path?token=[redacted] then token=[redacted]");
  });

  it("retains long bodies and all messages while neutralizing executable markup", () => {
    const body = `${"A long body. ".repeat(400)} https://example.invalid/resource <script>alert('x')</script>`;
    const conversation = normalize(rawConversation({ messages: [
      { id: "1", author: { id: 10, display_name: "Professor Rivera" }, body, created_at: "2026-09-19T13:00:00Z", attachments: [] },
      { id: "2", author: { id: 20, display_name: "Student" }, body: "Second complete message", created_at: "2026-09-20T13:00:00Z", attachments: [] },
    ], message_count: 2 }));
    expect(conversation.messages ?? []).toHaveLength(2);
    expect(conversation.messages?.[0]?.body).toContain("A long body.");
    expect(conversation.messages?.[0]?.body).toContain("https://example.invalid/resource");
    expect(conversation.messages?.[0]?.body).not.toContain("alert");
    expect(conversation.messages?.[0]?.author).toBe("Professor Rivera");
    expect(conversation.historyComplete).toBe(true);
    expect(conversation.safetyTruncated).toBe(false);
  });

  it("marks a generous safety ceiling instead of silently clipping history", () => {
    const messages = Array.from({ length: 2_001 }, (_, index) => ({ id: index, body: `Message ${index}`, created_at: `2026-09-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`, attachments: [] }));
    const conversation = normalize(rawConversation({ messages, message_count: 2_001 }));
    expect(conversation.messages ?? []).toHaveLength(2_000);
    expect(conversation.messageCount).toBe(2_001);
    expect(conversation.historyComplete).toBe(false);
    expect(conversation.safetyTruncated).toBe(true);
  });

  it("loads a preview-only summary as an explicitly incomplete legacy thread", () => {
    const conversation = normalize(rawConversation({ messages: undefined, message_count: 1, last_message: "Legacy preview" }));
    expect(conversation.messages ?? []).toHaveLength(1);
    expect(conversation.messages?.[0]?.body).toBe("Legacy preview");
    expect(conversation.historyComplete).toBe(false);
    expect(conversation.safetyTruncated).toBe(false);
  });

  it("uses the newest message when the Canvas summary fields are absent", () => {
    const conversation = normalize(rawConversation({ last_message: undefined, last_message_at: undefined }));
    expect(conversation.latestMessagePreview).toBe("Please review the rubric");
    expect(conversation.latestMessageAt).toBe("2026-09-20T18:30:00.000Z");
  });

  it("deduplicates repeated participants by Canvas user id", () => {
    const conversation = normalize(
      rawConversation({ participants: [{ id: 10, name: "Professor Rivera" }, { id: "10", name: "Duplicate" }] }),
    );
    expect(conversation.participants).toEqual([{ canvasUserId: "10", name: "Professor Rivera" }]);
  });

  it("rejects malformed fields without throwing", () => {
    expect(normalizeCanvasConversation(null)).toEqual({ ok: false, reason: "invalid_conversation" });
    expect(normalizeCanvasConversation(rawConversation({ participants: "not-an-array" }))).toEqual({
      ok: false,
      reason: "invalid_field",
    });
    expect(normalizeCanvasConversation(rawConversation({ messages: [{ body: 42 }] }))).toEqual({
      ok: false,
      reason: "invalid_field",
    });
  });

  it("rejects oversized arrays before projecting their contents", () => {
    const participants = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, name: `Person ${index}` }));
    expect(normalizeCanvasConversation(rawConversation({ participants }))).toEqual({
      ok: false,
      reason: "limit_exceeded",
    });

    const attachments = Array.from({ length: 26 }, (_, index) => ({ display_name: `file-${index}.txt` }));
    expect(normalizeCanvasConversation(rawConversation({ messages: [{ body: "hello", attachments }] }))).toEqual({
      ok: false,
      reason: "limit_exceeded",
    });
  });
});

describe("diffConversationSnapshots", () => {
  it("reports added, changed, and removed conversations for a complete snapshot", () => {
    const unchanged = normalize(rawConversation({ id: 1, subject: "Unchanged" }));
    const beforeChanged = normalize(rawConversation({ id: 2, subject: "Old" }));
    const afterChanged = normalize(rawConversation({ id: 2, subject: "New" }));
    const removed = normalize(rawConversation({ id: 3, subject: "Gone" }));
    const added = normalize(rawConversation({ id: 4, subject: "Added" }));

    expect(diffConversationSnapshots([unchanged, beforeChanged, removed], [unchanged, afterChanged, added], true)).toEqual({
      added: [added],
      changed: [{ before: beforeChanged, after: afterChanged }],
      removed: [removed],
    });
  });

  it("never reports removals from an incomplete snapshot", () => {
    const existing = normalize(rawConversation({ id: 1 }));
    expect(diffConversationSnapshots([existing], [], false)).toEqual({ added: [], changed: [], removed: [] });
  });
});
