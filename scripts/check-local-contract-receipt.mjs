import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const requiredChecks = ["stableIds", "completionFields", "unknownFieldPreservation", "refreshConsumer", "bindExclusion", "writerDisposition", "rollback"];
const forbiddenKeys = /(?:path|course|student|grade|message|schedule|credential|token|secret|response|name)/i;

function verify(value) {
  if (value.schemaVersion !== 1 || value.kind !== "duegood-local-contract-preflight") throw new Error("Invalid receipt envelope.");
  if (!value.checks || typeof value.checks !== "object") throw new Error("Missing checks.");
  for (const check of requiredChecks) {
    if (!["pass", "fail"].includes(value.checks[check])) throw new Error(`Missing bounded result for ${check}.`);
  }
  const walk = (node, key = "") => {
    if (forbiddenKeys.test(key)) throw new Error(`Private-value-shaped key is prohibited: ${key}`);
    if (typeof node === "string" && key !== "kind" && !/^(pass|fail|retired|supervised-child|rollback-only|unknown)$/.test(node)) {
      throw new Error("Receipt strings must use the redacted vocabulary.");
    }
    if (Array.isArray(node)) node.forEach((item) => walk(item));
    else if (node && typeof node === "object") Object.entries(node).forEach(([childKey, child]) => walk(child, childKey));
  };
  walk(value);
}

if (process.argv.includes("--self-test")) {
  const dir = mkdtempSync(path.join(tmpdir(), "duegood-contract-"));
  try {
    const valid = { schemaVersion: 1, kind: "duegood-local-contract-preflight", checks: Object.fromEntries(requiredChecks.map((key) => [key, "pass"])) };
    const file = path.join(dir, "receipt.json");
    writeFileSync(file, JSON.stringify(valid));
    verify(JSON.parse(readFileSync(file, "utf8")));
    let rejected = false;
    try { verify({ ...valid, privatePath: "/private/value" }); } catch { rejected = true; }
    if (!rejected) throw new Error("Self-test accepted a private-value-shaped field.");
    console.log("Local contract receipt verifier self-test passed.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
} else {
  const file = process.argv[2];
  if (!file) throw new Error("usage: check-local-contract-receipt.mjs RECEIPT");
  verify(JSON.parse(readFileSync(file, "utf8")));
  console.log("Local contract receipt verified.");
}
