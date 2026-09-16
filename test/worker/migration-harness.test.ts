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

    // The suite's real migrations/*.sql are applied ahead of this test by the global setup file
    // (see vitest.config.ts), so this only asserts the probe itself was recorded exactly once —
    // proving repeat application is idempotent — not that it's the only migration ever applied.
    const probeNames = applied.results.map(({ name }) => name).filter((name) => name === probeMigrations[0]?.name);
    expect(probeNames).toHaveLength(1);
    expect(probe?.label).toBe("synthetic");
  });
});
