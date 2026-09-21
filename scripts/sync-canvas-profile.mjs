import path from "node:path";
import { syncCanvasProfile } from "../src/canvas/profile-sync.ts";

function fail(message) {
  process.stderr.write(`duegood-profile: ${message}\n`);
  process.exitCode = 64;
}

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length;) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error("expected --profile-output PATH --avatar-output PATH");
    result[key.slice(2)] = value;
    index += 2;
  }
  if (!result["profile-output"] || !result["avatar-output"]) throw new Error("--profile-output and --avatar-output are required");
  if (!path.isAbsolute(result["profile-output"]) || !path.isAbsolute(result["avatar-output"])) throw new Error("profile and avatar outputs must be absolute paths");
  return result;
}

try {
  const config = options(process.argv.slice(2));
  const accessToken = process.env.CANVAS_API_TOKEN;
  if (!accessToken) throw new Error("Canvas access token is required through the approved environment broker");
  await syncCanvasProfile({
    accessToken,
    profileOutputPath: config["profile-output"],
    avatarOutputPath: config["avatar-output"],
    onStatus: (message) => process.stderr.write(`duegood-profile: ${message}\n`),
  });
} catch (error) {
  fail(error instanceof Error ? error.message : "profile sync failed");
}
