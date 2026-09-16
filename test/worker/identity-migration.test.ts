import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("identity migration", () => {
  it("is recorded as applied by the D1 migration harness", async () => {
    const applied = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();

    expect(applied.results.map((row) => row.name)).toContain("0001_identity.sql");
  });

  it("enforces the institution-plus-canvas-user-id uniqueness constraint at the schema level", async () => {
    await env.DB.prepare(
      "INSERT INTO accounts (institution_origin, canvas_user_id, created_at) VALUES (?1, ?2, ?3)",
    )
      .bind("https://schema-check.instructure.com", "99", 1)
      .run();

    await expect(
      env.DB.prepare(
        "INSERT INTO accounts (institution_origin, canvas_user_id, created_at) VALUES (?1, ?2, ?3)",
      )
        .bind("https://schema-check.instructure.com", "99", 2)
        .run(),
    ).rejects.toThrow();
  });
});
