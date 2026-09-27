/**
 * Extract bounded text and a safe link ledger from Canvas rich text.
 *
 * `extractCanvasHtmlInPage` is self-contained so a caller can run it inside the
 * fixed Canvas page with Playwright's `page.evaluate`. It never returns source
 * HTML, URL credentials, verifier values, unknown query values, or sharing
 * tokens embedded in known sharing paths.
 */
export function extractCanvasHtmlInPage(input) {
  const fixedOrigin = "https://marymount.instructure.com";
  const limits = Object.freeze({
    htmlBytes: 512 * 1024,
    textCharacters: 64 * 1024,
    links: 200,
    urlCharacters: 2048,
    titleCharacters: 256,
    sourceCharacters: 96,
  });
  const fail = (code) => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };
  const allowedLimits = (options) => {
    const requested = {
      htmlBytes: options.maxHtmlBytes ?? limits.htmlBytes,
      textCharacters: options.maxTextCharacters ?? limits.textCharacters,
      links: options.maxLinks ?? limits.links,
    };
    if (!Number.isSafeInteger(requested.htmlBytes) || requested.htmlBytes < 1 || requested.htmlBytes > limits.htmlBytes
        || !Number.isSafeInteger(requested.textCharacters) || requested.textCharacters < 1 || requested.textCharacters > limits.textCharacters
        || !Number.isSafeInteger(requested.links) || requested.links < 1 || requested.links > limits.links) {
      fail("INVALID_LIMIT");
    }
    return requested;
  };
  const cleanLabel = (value, maxLength) => String(value ?? "")
    .replace(/\b(?:https?:)?\/\/[^\s<>"'`]+/giu, " [link] ")
    .replace(/(?:^|\s)(?:\/|\.{1,2}\/)[^\s<>"'`]*\?[^\s<>"'`#]*(?:verifier|token|signature|sig|access_token|auth|credential|password|x-amz-)[^\s<>"'`#]*/giu, " [link] ")
    .replace(/\b(?:javascript|data):[^\s<>"'`]+/giu, " [link] ")
    .replace(/\b(?:verifier|(?:access[_-]?)?token|signature|sig|auth(?:orization)?|credential|password|policy|expires|awsaccesskeyid|(?:x-amz|x-goog)-[a-z0-9_-]+|se|sp|sv)\s*[:=]\s*[^\s&;,<>"'`]+/giu, "[redacted]")
    .replace(/[\u00a0\s]+/gu, " ")
    .trim()
    .slice(0, maxLength);
  const safeSource = (value) => cleanLabel(value || "unknown", limits.sourceCharacters) || "unknown";
  const publicQueryKeys = Object.freeze({
    "marymount.instructure.com": new Set(["page", "per_page", "tab"]),
    "youtube.com": new Set(["v", "t", "list", "index", "start"]),
    "www.youtube.com": new Set(["v", "t", "list", "index", "start"]),
    "youtu.be": new Set(["t"]),
  });
  const secretQueryKey = (key) => {
    const normalized = key.toLowerCase();
    return normalized.includes("verifier")
      || normalized.includes("token")
      || normalized.includes("signature")
      || normalized === "sig"
      || normalized.includes("auth")
      || normalized.includes("credential")
      || normalized.includes("password")
      || normalized === "policy"
      || normalized === "expires"
      || normalized.startsWith("x-amz-")
      || normalized.startsWith("x-goog-")
      || ["awsaccesskeyid", "se", "sp", "sv"].includes(normalized);
  };
  const knownSharingHost = (hostname) => {
    const host = hostname.toLowerCase();
    return host === "drive.google.com"
      || host === "docs.google.com"
      || host === "1drv.ms"
      || host === "onedrive.live.com"
      || host === "dropbox.com"
      || host.endsWith(".dropbox.com")
      || host === "box.com"
      || host.endsWith(".box.com")
      || host.endsWith(".sharepoint.com");
  };
  const sanitizeLink = (rawHref, details = {}) => {
    const source = safeSource(details.source);
    const title = cleanLabel(details.title, limits.titleCharacters);
    const empty = (reason, asciiHostname = null) => ({
      source, title, asciiHostname, safeTarget: null, clickable: false, reason,
    });
    if (typeof rawHref !== "string" || rawHref.trim().length === 0) return empty("empty-url");
    const href = rawHref.trim();
    if (href.length > limits.urlCharacters) return empty("url-too-long");

    let base;
    let url;
    try {
      base = new URL(typeof details.baseUrl === "string" ? details.baseUrl : `${fixedOrigin}/`);
      if (base.origin !== fixedOrigin || base.protocol !== "https:" || base.username || base.password) return empty("invalid-base");
      base.search = "";
      base.hash = "";
      url = new URL(href, base);
    } catch {
      return empty("invalid-url");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return empty("unsafe-scheme");
    if (!url.hostname || url.username || url.password) return empty("credentials-removed");
    url.hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    const asciiHostname = url.hostname;
    if ([...url.searchParams.keys()].some(secretQueryKey)) return empty("access-url-removed", asciiHostname);

    url.hash = "";
    if (knownSharingHost(asciiHostname)) {
      url.pathname = "/";
      url.search = "";
      return {
        source, title, asciiHostname, safeTarget: url.origin + "/", clickable: false,
        reason: "sharing-token-removed",
      };
    }

    const allowed = publicQueryKeys[asciiHostname] ?? new Set();
    const safeParams = new URLSearchParams();
    const seenKeys = new Set();
    for (const [key, value] of url.searchParams) {
      const normalized = key.toLowerCase();
      if (!allowed.has(normalized) || seenKeys.has(normalized) || !/^[\w-]{1,64}$/u.test(value)) continue;
      safeParams.set(normalized, value);
      seenKeys.add(normalized);
    }
    url.search = safeParams.toString();
    const safeTarget = url.href;
    const clickable = url.protocol === "https:";
    return {
      source, title, asciiHostname, safeTarget, clickable,
      ...(!clickable ? { reason: "insecure-http" } : {}),
    };
  };

  if (input === null || typeof input !== "object" || Array.isArray(input)) fail("INVALID_INPUT");
  const options = input.options !== null && typeof input.options === "object" && !Array.isArray(input.options)
    ? input.options
    : input;
  if (input.mode === "sanitize") {
    return sanitizeLink(input.href, {
      source: input.source,
      title: input.title,
      baseUrl: input.baseUrl,
    });
  }
  if (typeof input.html !== "string") fail("INVALID_HTML");
  const bounded = allowedLimits(options);
  const htmlBytes = new TextEncoder().encode(input.html).byteLength;
  if (htmlBytes > bounded.htmlBytes) fail("HTML_SIZE_LIMIT");
  if (typeof globalThis.DOMParser !== "function") fail("PARSER_UNAVAILABLE");

  const document = new globalThis.DOMParser().parseFromString(input.html, "text/html");
  for (const element of document.querySelectorAll("script, style, template, noscript, iframe, object, embed, form, [hidden], [aria-hidden='true']")) {
    element.remove();
  }
  const source = safeSource(options.source);
  const links = [];
  let linksTruncated = false;
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (href === null || href.trim() === "") continue;
    if (links.length >= bounded.links) {
      linksTruncated = true;
      break;
    }
    const title = cleanLabel(anchor.getAttribute("title") || anchor.textContent, limits.titleCharacters);
    links.push(sanitizeLink(href, { source, title, baseUrl: options.baseUrl }));
  }

  const rawText = document.body?.textContent ?? "";
  const text = cleanLabel(rawText, bounded.textCharacters);
  return {
    text,
    links,
    textTruncated: text.length === bounded.textCharacters && cleanLabel(rawText, bounded.textCharacters + 1).length > text.length,
    linksTruncated,
  };
}

/** Sanitize one URL without requiring a DOM implementation. */
export function sanitizeCanvasLink(rawHref, details = {}) {
  return extractCanvasHtmlInPage({ mode: "sanitize", href: rawHref, ...details });
}

/** Parse Canvas rich text in the browser and return text plus its safe link ledger. */
export function extractCanvasHtml(html, options = {}) {
  return extractCanvasHtmlInPage({ html, options });
}
