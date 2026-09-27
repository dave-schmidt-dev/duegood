import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractCanvasHtmlInPage,
  sanitizeCanvasLink,
} from "../../scripts/canvas-browser-links.mjs";

let browser: Browser;
type ParsedHtml = { text: string; links: Array<Record<string, unknown>>; textTruncated: boolean; linksTruncated: boolean };
type LinkLedgerEntry = { source: string; title: string; asciiHostname: string | null; safeTarget: string | null; clickable: boolean; reason?: string };
const sanitize = (href: string): LinkLedgerEntry => sanitizeCanvasLink(href) as LinkLedgerEntry;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

async function parseSynthetic(html: string, options: Record<string, unknown> = {}) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(extractCanvasHtmlInPage, { html, options }) as ParsedHtml;
  } finally {
    await page.close();
  }
}

describe("Canvas rich-text link sanitation", () => {
  it("extracts decoded bounded text and removes nested signed URLs from output", async () => {
    const result = await parseSynthetic(
      `<p>  A&nbsp; &amp; B </p>
       <p><a title="Open &amp; review" href="/courses/12/files/44/download?verifier=synthetic-secret&amp;download_frd=1#preview"><strong>File&nbsp;link</strong></a></p>
       <div><a href="https://marymount.instructure.com/courses/12/pages/topic?X-Amz-Signature=synthetic-signature">nested signed link</a></div>
       <img src="https://marymount.instructure.com/files/44/download?verifier=synthetic-image-secret" alt="Preview">
       <script>synthetic-script-secret</script>`,
      { source: "course/12/page", baseUrl: "https://marymount.instructure.com/courses/12/pages/current" },
    );

    expect(result.text).toContain("A & B");
    expect(result.text).toContain("File link");
    expect(result.text).not.toContain("synthetic-secret");
    expect(result.text).not.toContain("synthetic-script-secret");
    expect(result.links).toHaveLength(2);
    expect(result.links[0]).toMatchObject({
      source: "course/12/page",
      title: "Open & review",
      asciiHostname: "marymount.instructure.com",
      safeTarget: null,
      clickable: false,
      reason: "access-url-removed",
    });
    expect(result.links[1]).toMatchObject({ safeTarget: null, reason: "access-url-removed" });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(JSON.stringify(result)).not.toContain("synthetic-signature");
    expect(JSON.stringify(result)).not.toContain("synthetic-image-secret");
  });

  it("rejects executable schemes, emits ASCII IDN hosts, and strips sharing path tokens", () => {
    expect(sanitize("javascript:alert(1)")).toMatchObject({
      asciiHostname: null, safeTarget: null, clickable: false, reason: "unsafe-scheme",
    });
    expect(sanitize("data:text/html,synthetic-secret")).toMatchObject({
      asciiHostname: null, safeTarget: null, clickable: false, reason: "unsafe-scheme",
    });

    expect(sanitize("https://exämple.com/course?q=synthetic&ref=source#fragment")).toMatchObject({
      asciiHostname: "xn--exmple-cua.com",
      safeTarget: "https://xn--exmple-cua.com/course",
      clickable: true,
    });
    expect(sanitize("https://drive.google.com/file/d/synthetic-share-token/view?usp=sharing")).toMatchObject({
      asciiHostname: "drive.google.com",
      safeTarget: "https://drive.google.com/",
      clickable: false,
      reason: "sharing-token-removed",
    });
    expect(sanitize("https://drive.google.com。/file/d/synthetic-unicode-host-token")).toMatchObject({
      asciiHostname: "drive.google.com",
      safeTarget: "https://drive.google.com/",
      clickable: false,
      reason: "sharing-token-removed",
    });
  });

  it("keeps only reviewed public query values and strips text URLs", async () => {
    const canvas = sanitize("https://marymount.instructure.com/courses/12?tab=modules&page=2&unknown=synthetic#top");
    expect(canvas.safeTarget).toBe("https://marymount.instructure.com/courses/12?tab=modules&page=2");

    const external = sanitize("https://outside.example/path?public=synthetic#fragment");
    expect(external.safeTarget).toBe("https://outside.example/path");

    const result = await parseSynthetic(
      "<p>Read https://example.test/path?verifier=synthetic-text-secret then /relative?token=synthetic-relative-secret</p>",
    );
    expect(result.text).not.toContain("synthetic-text-secret");
    expect(result.text).not.toContain("synthetic-relative-secret");
  });

  it("redacts standalone verifier and access values in text, title, and source labels", async () => {
    const result = await parseSynthetic(
      `<p>verifier=synthetic-verifier access_token=synthetic-access signature: synthetic-signature</p>
       <a title="auth=synthetic-title-secret" href="/safe">Safe link</a>`,
      { source: "course?token=synthetic-source-secret" },
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("synthetic-verifier");
    expect(serialized).not.toContain("synthetic-access");
    expect(serialized).not.toContain("synthetic-signature");
    expect(serialized).not.toContain("synthetic-title-secret");
    expect(serialized).not.toContain("synthetic-source-secret");
    expect(result.text).toContain("[redacted]");
    expect(result.links[0]?.source).toBe("course?[redacted]");
  });

  it("enforces HTML, text, and ledger caps", async () => {
    await expect(parseSynthetic("<p>12345</p>", { maxHtmlBytes: 4 }))
      .rejects.toThrow("HTML_SIZE_LIMIT");

    const shortText = await parseSynthetic("<p>abcdef</p>", { maxTextCharacters: 3 });
    expect(shortText.text).toBe("abc");
    expect(shortText.textTruncated).toBe(true);

    const fewLinks = await parseSynthetic(
      "<a href='/one'>one</a><a href='/two'>two</a><a href='/three'>three</a>",
      { maxLinks: 2 },
    );
    expect(fewLinks.links).toHaveLength(2);
    expect(fewLinks.linksTruncated).toBe(true);
  });
});

describe("compiled capture-state helper", () => {
  it("persists increasing run IDs and failed attempts in a private test root", () => {
    const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const build = spawnSync("cargo", ["build", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--features", "test-overrides", "--bin", "duegood-capture-state"], {
      cwd: projectRoot, stdio: "inherit", timeout: 120_000,
    });
    expect(build.status).toBe(0);
    const binary = join(process.env.CARGO_TARGET_DIR ?? join(projectRoot, "src-tauri", "target"),
      "debug", "duegood-capture-state");
    const temporary = mkdtempSync(join(tmpdir(), "duegood-capture-state-cli-"));
    const cleanup = () => rmSync(temporary, { recursive: true, force: true });
    process.once("exit", cleanup);
    const dataRoot = join(temporary, "com.zerodelta.duegood.test");
    try {
      mkdirSync(dataRoot, { mode: 0o700 });
      const invoke = (...args: string[]) => spawnSync(binary, args, {
        cwd: projectRoot,
        env: { ...process.env, DUEGOOD_TEST_DATA_ROOT: dataRoot },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(invoke("status").stdout.trim()).toBe("run=0 status=none");
      expect(invoke("begin").stdout.trim()).toBe("run=1 status=running");
      expect(invoke("status").stdout.trim()).toBe("run=1 status=running");
      expect(invoke("begin").stdout.trim()).toBe("run=2 status=running");
      expect(invoke("fail", "1").status).not.toBe(0);
      expect(invoke("fail", "2").stdout.trim()).toBe("run=2 status=failed");
      expect(invoke("status").stdout.trim()).toBe("run=2 status=failed");
      expect(statSync(dataRoot).mode & 0o777).toBe(0o700);
      for (const name of ["canvas-capture-run-counter.json", "canvas-capture-attempt.json"]) {
        expect(statSync(join(dataRoot, name)).mode & 0o777).toBe(0o600);
        expect(readFileSync(join(dataRoot, name), "utf8")).not.toContain("verifier");
      }
    } finally {
      cleanup();
      process.off("exit", cleanup);
    }
  }, 130_000);
});
