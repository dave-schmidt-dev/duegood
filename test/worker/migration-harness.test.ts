import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const probeMigrations: D1Migration[] = [
  {
    name: "0000_task-1-1-probe.sql",
    queries: [
      "CREATE TABLE task_1_1_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
      "INSERT INTO task_1_1_probe (id, label) VALUES (1, 'synthetic')",
    ],
  },
];

describe("D1 migration harness", () => {
  it("applies and records every named migration through the pinned Worker runtime", async () => {
    await applyD1Migrations(env.DB, probeMigrations);
    await applyD1Migrations(env.DB, probeMigrations);

    const applied = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    const probe = await env.DB.prepare("SELECT label FROM task_1_1_probe WHERE id = 1").first<{ label: string }>();

    expect(applied.results.map(({ name }) => name)).toEqual(probeMigrations.map(({ name }) => name));
    expect(probe?.label).toBe("synthetic");
  });
});
