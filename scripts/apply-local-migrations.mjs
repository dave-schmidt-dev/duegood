import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(root, "migrations");

export async function discoverMigrations() {
  try {
    const entries = await readdir(migrationsDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^\d{4}_[a-z0-9-]+\.sql$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

const migrations = await discoverMigrations();
console.log(`Discovered ${migrations.length} local D1 migration(s).`);
for (const migration of migrations) console.log(`- ${migration}`);

if (!process.argv.includes("--list")) {
  if (migrations.length === 0) {
    console.log("No local D1 migrations are present yet; nothing to apply.");
  } else {
    const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
    console.log("Applying pending migrations to the project-local D1 state.");
    const result = spawnSync(
      wrangler,
      ["d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", ".wrangler/state"],
      { cwd: root, stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error("Local D1 migration application failed.");
  }
}
