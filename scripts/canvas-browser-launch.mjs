/**
 * Launch options for the dedicated Canvas capture profile. Headless Chrome is the default;
 * headless mode presents the installed desktop Chrome user agent without the Headless marker.
 */
import { readFile } from "node:fs/promises";

const CHROME_INFO_PLIST = "/Applications/Google Chrome.app/Contents/Info.plist";

/** A desktop Chrome user agent for the installed major version, without the Headless marker. */
export function desktopChromeUserAgent(major) {
  if (!Number.isSafeInteger(major) || major < 100 || major > 999) throw new Error("HEADLESS_USER_AGENT_UNAVAILABLE");
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Reads the installed Chrome major version from its bundle metadata. */
export async function installedChromeMajor(plistPath = CHROME_INFO_PLIST) {
  const text = await readFile(plistPath, "utf8").catch(() => "");
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>(\d{2,3})\.[0-9.]+<\/string>/u.exec(text);
  if (!match) throw new Error("HEADLESS_USER_AGENT_UNAVAILABLE");
  return Number(match[1]);
}

/** Launch options for the dedicated profile; headless mode replaces the HeadlessChrome user agent. */
export async function sessionLaunchOptions({ headless = true, chromeMajor = installedChromeMajor } = {}) {
  return {
    channel: "chrome", headless, args: ["--disable-http-cache"], timeout: 20_000,
    ...(headless ? { userAgent: desktopChromeUserAgent(await chromeMajor()) } : {}),
  };
}
