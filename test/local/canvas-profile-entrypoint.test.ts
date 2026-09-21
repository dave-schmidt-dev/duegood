import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_AVATAR_BYTES, syncCanvasProfile, validateAvatarUrl } from "../../src/canvas/profile-sync";

const directories: string[] = [];
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function response(body: BodyInit, headers: Record<string, string>, status = 200): Response {
  return new Response(body, { status, headers });
}

async function setup(): Promise<{ root: string; profile: string; avatar: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "duegood-profile-"));
  directories.push(root);
  return { root, profile: path.join(root, "canvas-profile.json"), avatar: path.join(root, "canvas-profile-avatar.png") };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Canvas profile sync", () => {
  it("uses the exact profile endpoint, omits authorization from avatar fetches, and writes sanitized local metadata", async () => {
    const paths = await setup();
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const result = await syncCanvasProfile({
      accessToken: "synthetic-token",
      profileOutputPath: paths.profile,
      avatarOutputPath: paths.avatar,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        if (url.endsWith("/profile")) return response(JSON.stringify({ name: "  Synthetic  Student\n", short_name: " Synthetic ", avatar_url: "https://marymount.instructure.com/avatar.png", private_field: "discard" }), { "content-type": "application/json" });
        return response(PNG, { "content-type": "image/png", "content-length": String(PNG.length) });
      },
    });
    expect(result.avatarDownloaded).toBe(true);
    expect(calls).toEqual([
      { url: "https://marymount.instructure.com/api/v1/users/self/profile", authorization: "Bearer synthetic-token" },
      { url: "https://marymount.instructure.com/avatar.png", authorization: null },
    ]);
    const saved = JSON.parse(await readFile(paths.profile, "utf8")) as Record<string, unknown>;
    expect(saved).toEqual({ name: "Synthetic Student", short_name: "Synthetic", avatar: { path: "canvas-profile-avatar.png", contentType: "image/png", bytes: PNG.length } });
    expect(JSON.stringify(saved)).not.toContain("avatar_url");
    expect((await stat(paths.profile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.avatar)).mode & 0o777).toBe(0o600);
  });

  it("rejects unsafe avatar hosts, credentials, IP literals, and non-HTTPS redirects", () => {
    for (const value of [
      "http://marymount.instructure.com/avatar.png",
      "https://user:pass@marymount.instructure.com/avatar.png",
      "https://127.0.0.1/avatar.png",
      "https://localhost/avatar.png",
      "https://evil.example/avatar.png",
    ]) expect(() => validateAvatarUrl(value)).toThrow();
    expect(validateAvatarUrl("https://secure.gravatar.com/avatar/synthetic").hostname).toBe("secure.gravatar.com");
  });

  it("rejects an oversized avatar before replacing existing profile or avatar files", async () => {
    const paths = await setup();
    const oldProfile = '{"name":"Existing","short_name":"Existing","avatar":{"path":"canvas-profile-avatar.png","contentType":"image/png","bytes":1}}\n';
    const oldAvatar = Buffer.from("old-avatar");
    await writeFile(paths.profile, oldProfile, { mode: 0o600 });
    await writeFile(paths.avatar, oldAvatar, { mode: 0o600 });
    await expect(syncCanvasProfile({
      accessToken: "synthetic-token",
      profileOutputPath: paths.profile,
      avatarOutputPath: paths.avatar,
      fetchImpl: async (input) => String(input).endsWith("/profile")
        ? response(JSON.stringify({ name: "New", short_name: "New", avatar_url: "https://marymount.instructure.com/avatar.png" }), { "content-type": "application/json" })
        : response(PNG, { "content-type": "image/png", "content-length": String(MAX_AVATAR_BYTES + 1) }),
    })).rejects.toThrow(/5 MB/);
    expect(await readFile(paths.profile, "utf8")).toBe(oldProfile);
    expect(await readFile(paths.avatar)).toEqual(oldAvatar);
  });

  it("rejects unsafe redirects and unsupported image types", async () => {
    const paths = await setup();
    let profileCall = true;
    await expect(syncCanvasProfile({
      accessToken: "synthetic-token",
      profileOutputPath: paths.profile,
      avatarOutputPath: paths.avatar,
      fetchImpl: async (_input, init) => {
        if (profileCall) { profileCall = false; return response(JSON.stringify({ name: "Synthetic", avatar_url: "https://marymount.instructure.com/avatar.png" }), { "content-type": "application/json" }); }
        expect(init?.redirect).toBe("manual");
        return response("redirect", { location: "http://evil.example/avatar.png" }, 302);
      },
    })).rejects.toThrow(/unsafe|allowed/);
  });
});
