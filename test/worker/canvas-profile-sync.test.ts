import { describe, expect, it } from "vitest";
import { CANVAS_PROFILE_ENDPOINT, validateAvatarUrl } from "../../src/canvas/profile-sync";

describe("Canvas profile endpoint contract", () => {
  it("uses the fixed authenticated Marymount profile path", () => {
    expect(new URL(CANVAS_PROFILE_ENDPOINT)).toMatchObject({
      protocol: "https:",
      hostname: "marymount.instructure.com",
      pathname: "/api/v1/users/self/profile",
    });
  });

  it("allows only approved HTTPS avatar host families", () => {
    expect(validateAvatarUrl("https://canvas.instructure.com/avatar.png").hostname).toBe("canvas.instructure.com");
    expect(validateAvatarUrl("https://files.instructureusercontent.com/avatar.webp").hostname).toBe("files.instructureusercontent.com");
    expect(validateAvatarUrl("https://inst-fs-iad-prod.inscloudgate.net/avatar").hostname).toBe("inst-fs-iad-prod.inscloudgate.net");
    expect(validateAvatarUrl("https://www.gravatar.com/avatar/synthetic").hostname).toBe("www.gravatar.com");
    expect(() => validateAvatarUrl("https://127.0.0.1/avatar.png")).toThrow();
    expect(() => validateAvatarUrl("https://inscloudgate.net.evil.invalid/avatar.png")).toThrow();
  });
});
