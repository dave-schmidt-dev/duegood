import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function verify(receipt, expected = {}) {
  if (receipt.schemaVersion !== 1) throw new Error("Unsupported receipt schema.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(receipt.taskId ?? "")) throw new Error("Invalid task identity.");
  if (!/^(done|failed|blocked)$/.test(receipt.status ?? "")) throw new Error("Invalid terminal status.");
  for (const [name, value] of [["baselineTree", receipt.baselineTree], ["modelMetadataSha256", receipt.modelMetadataSha256], ["patchSha256", receipt.patchSha256]]) {
    if (!/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`Invalid ${name}.`);
  }
  if (receipt.executorImage !== "duegood-opencode:1.18.30") throw new Error("Executor image drift.");
  if (receipt.proxySourceRevision !== "609eb8931420453daf5893509be0b25b21bd9edb") throw new Error("Proxy source drift.");
  if (receipt.modelMetadata?.opencodeVersion !== "1.18.30") throw new Error("OpenCode version drift.");
  if (receipt.modelMetadata?.model !== "opencode-go/deepseek-v4.1-flash") throw new Error("Model selector drift.");
  if (receipt.modelMetadata?.variant !== "high") throw new Error("Model variant drift.");
  if (receipt.environment?.sourceHasGitMetadata !== false || receipt.environment?.credentialsReadOnly !== true) {
    throw new Error("Isolation evidence is missing.");
  }
  if (receipt.environment?.networkPolicy !== "smokescreen-enforce-https-allowlist") throw new Error("Network policy drift.");
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key] !== value) throw new Error(`${key} does not match the task contract.`);
  }
}

function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), "duegood-receipt-"));
  try {
    const metadata = Buffer.from('{"opencodeVersion":"1.18.30","model":"opencode-go/deepseek-v4.1-flash","variant":"high"}\n');
    const patch = Buffer.from("diff --git a/README.md b/README.md\n");
    const valid = {
      schemaVersion: 1,
      taskId: "self-test",
      status: "done",
      baselineTree: "a".repeat(64),
      executorImage: "duegood-opencode:1.18.30",
      proxySourceRevision: "609eb8931420453daf5893509be0b25b21bd9edb",
      modelMetadata: JSON.parse(metadata),
      modelMetadataSha256: sha256(metadata),
      patchSha256: sha256(patch),
      environment: { networkPolicy: "smokescreen-enforce-https-allowlist", sourceHasGitMetadata: false, credentialsReadOnly: true },
    };
    writeFileSync(path.join(dir, "receipt.json"), JSON.stringify(valid));
    verify(JSON.parse(readFileSync(path.join(dir, "receipt.json"), "utf8")));
    for (const mutate of [
      (copy) => { copy.executorImage = "latest"; },
      (copy) => { copy.modelMetadata.model = "unexpected/model"; },
      (copy) => { copy.environment.credentialsReadOnly = false; },
      (copy) => { copy.patchSha256 = "bad"; },
    ]) {
      const copy = structuredClone(valid);
      mutate(copy);
      let rejected = false;
      try { verify(copy); } catch { rejected = true; }
      if (!rejected) throw new Error("Self-test accepted a malformed receipt.");
    }
    console.log("Executor receipt verifier self-test passed.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
} else {
  const receiptPath = args.find((arg) => !arg.startsWith("--"));
  if (!receiptPath) throw new Error("usage: verify-executor-receipt.mjs RECEIPT [--task TASK] [--baseline TREE]");
  const taskIndex = args.indexOf("--task");
  const baselineIndex = args.indexOf("--baseline");
  const expected = {};
  if (taskIndex >= 0) expected.taskId = args[taskIndex + 1];
  if (baselineIndex >= 0) expected.baselineTree = args[baselineIndex + 1];
  verify(JSON.parse(readFileSync(receiptPath, "utf8")), expected);
  console.log("Executor receipt verified.");
}
