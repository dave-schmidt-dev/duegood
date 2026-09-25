import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const CANVAS_PROFILE_ENDPOINT = "https://marymount.instructure.com/api/v1/users/self/profile";
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

interface CanvasProfileMetadata {
  readonly name: string | null;
  readonly short_name: string | null;
  readonly avatar: {
    readonly path: string;
    readonly contentType: AvatarContentType;
    readonly bytes: number;
  } | null;
}

export interface ValidatedLocalCanvasProfile {
  readonly displayName: string;
  readonly avatarFilePath: string | null;
  readonly avatarContentType: AvatarContentType | null;
}

export interface CanvasProfileSyncOptions {
  readonly accessToken: string;
  readonly profileOutputPath: string;
  readonly avatarOutputPath: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly onStatus?: (message: string) => void;
}

export interface CanvasProfileSyncResult {
  readonly profile: CanvasProfileMetadata;
  readonly avatarDownloaded: boolean;
  readonly avatarBytes: number;
  readonly avatarContentType: AvatarContentType | null;
}

interface StagedFile {
  readonly target: string;
  readonly temporary: string;
  readonly backup: string;
  readonly existed: boolean;
  installed: boolean;
  backedUp: boolean;
}

function cleanText(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const result = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return result.length === 0 ? null : result.slice(0, max);
}

function contentType(value: string | null | undefined): AvatarContentType | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return AVATAR_CONTENT_TYPES.includes(normalized as AvatarContentType) ? normalized as AvatarContentType : null;
}

function allowedAvatarHost(value: URL): boolean {
  const host = value.hostname.toLowerCase();
  if (value.protocol !== "https:" || value.username !== "" || value.password !== "" || (value.port !== "" && value.port !== "443")) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host === "local") return false;
  if (/^[0-9a-f:.]+$/i.test(host)) return false;
  return host === "marymount.instructure.com"
    || host.endsWith(".instructure.com")
    || host === "instructureusercontent.com"
    || host.endsWith(".instructureusercontent.com")
    || host.endsWith(".inscloudgate.net")
    || host === "gravatar.com"
    || host.endsWith(".gravatar.com");
}

export function validateAvatarUrl(value: string, base = CANVAS_PROFILE_ENDPOINT): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error("Canvas avatar URL is invalid");
  }
  if (!allowedAvatarHost(url)) throw new Error(`Canvas avatar URL host is not allowed (${url.hostname})`);
  return url;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status <= 399;
}

function abortableSignal(timeoutMs: number): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

async function readBoundedBody(response: Response, maxBytes: number, label = "response"): Promise<Uint8Array> {
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`Canvas ${label} exceeds its size limit`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      total += chunk.length;
      if (total > maxBytes) throw new Error(`Canvas ${label} exceeds its size limit`);
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function readJsonProfile(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number.isSafeInteger(Number(declaredLength)) && Number(declaredLength) > 64 * 1024) throw new Error("Canvas profile response is too large");
  const bytes = await readBoundedBody(response, 64 * 1024, "profile response");
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new Error("Canvas profile response is not valid JSON"); }
}

function hasImageSignature(bytes: Uint8Array, type: AvatarContentType): boolean {
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  const text = (start: number, end: number): string => new TextDecoder().decode(bytes.subarray(start, end));
  if (type === "image/gif") return text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a";
  return bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP";
}

async function downloadAvatar(initialUrl: string, fetchImpl: typeof fetch, timeoutMs: number, onStatus: (message: string) => void): Promise<{ bytes: Uint8Array; contentType: AvatarContentType }> {
  let url = validateAvatarUrl(initialUrl);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const timeout = abortableSignal(timeoutMs);
    let response: Response;
    try {
      onStatus(`fetching avatar (${url.hostname})`);
      response = await fetchImpl(url, { headers: { Accept: "image/jpeg,image/png,image/webp,image/gif" }, redirect: "manual", signal: timeout.signal });
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (location === null || redirect === 3) throw new Error("Canvas avatar redirect is unsafe or too long");
        url = validateAvatarUrl(location, url.toString());
        continue;
      }
      if (!response.ok) throw new Error(`Canvas avatar request failed (${response.status})`);
      const type = contentType(response.headers.get("content-type"));
      if (type === null) throw new Error("Canvas avatar has an unsupported content type");
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && Number.isSafeInteger(Number(declaredLength)) && Number(declaredLength) > MAX_AVATAR_BYTES) throw new Error("Canvas avatar exceeds the 5 MB limit");
      const bytes = await readBoundedBody(response, MAX_AVATAR_BYTES, "avatar (5 MB)");
      if (!hasImageSignature(bytes, type)) throw new Error("Canvas avatar bytes do not match the declared image type");
      return { bytes, contentType: type };
    } finally {
      timeout.close();
    }
  }
  throw new Error("Canvas avatar redirect is unsafe or too long");
}

function requireAbsolutePath(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return resolved;
}

async function stageFile(target: string, bytes: Uint8Array<ArrayBufferLike>): Promise<StagedFile> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let existing = false;
  try {
    existing = (await stat(target)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing === false) {
    try {
      if ((await stat(target)).isDirectory()) throw new Error(`output path is a directory: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const suffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const temporary = path.join(directory, `.${path.basename(target)}.${suffix}.tmp`);
  const backup = path.join(directory, `.${path.basename(target)}.${suffix}.bak`);
  try {
    const writer = await open(temporary, "wx", 0o600);
    try { await writer.writeFile(bytes); } finally { await writer.close(); }
    await chmod(temporary, 0o600);
    const handle = await open(temporary, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    return { target, temporary, backup, existed: existing, installed: false, backedUp: false };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() => null);
  if (handle === null) return;
  try { await handle.sync(); } finally { await handle.close(); }
}

async function commitFiles(files: readonly StagedFile[]): Promise<void> {
  const committed: StagedFile[] = [];
  try {
    for (const file of files) {
      if (file.existed) {
        await rename(file.target, file.backup);
        file.backedUp = true;
      }
    }
    for (const file of files) {
      await rename(file.temporary, file.target);
      file.installed = true;
      committed.push(file);
      await chmod(file.target, 0o600);
    }
    await Promise.all([...new Set(files.map((file) => path.dirname(file.target)))].map(syncDirectory));
    await Promise.all(files.filter((file) => file.backedUp).map((file) => unlink(file.backup).catch(() => undefined)));
  } catch (error) {
    for (const file of committed.reverse()) await unlink(file.target).catch(() => undefined);
    for (const file of [...files].reverse()) {
      if (file.backedUp) await rename(file.backup, file.target).catch(() => undefined);
      else if (!file.installed) await unlink(file.temporary).catch(() => undefined);
    }
    throw error;
  } finally {
    await Promise.all(files.map((file) => unlink(file.temporary).catch(() => undefined)));
    await Promise.all(files.map((file) => unlink(file.backup).catch(() => undefined)));
  }
}

export async function syncCanvasProfile(options: CanvasProfileSyncOptions): Promise<CanvasProfileSyncResult> {
  const profileOutputPath = requireAbsolutePath(options.profileOutputPath, "profile output path");
  const avatarOutputPath = requireAbsolutePath(options.avatarOutputPath, "avatar output path");
  if (path.dirname(profileOutputPath) !== path.dirname(avatarOutputPath)) throw new Error("profile and avatar outputs must share a directory");
  if (typeof options.accessToken !== "string" || options.accessToken.trim() === "") throw new Error("Canvas access token is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const onStatus = options.onStatus ?? (() => undefined);
  const profileTimeout = abortableSignal(timeoutMs);
  let profileResponse!: Response;
  let raw: unknown = null;
  try {
    onStatus("fetching Canvas profile");
    profileResponse = await fetchImpl(CANVAS_PROFILE_ENDPOINT, {
      headers: { Accept: "application/json", Authorization: `Bearer ${options.accessToken}` },
      redirect: "manual",
      signal: profileTimeout.signal,
    });
    if (isRedirect(profileResponse.status)) throw new Error("Canvas profile redirect is unsafe");
    if (!profileResponse.ok) throw new Error(`Canvas profile request failed (${profileResponse.status})`);
    raw = await readJsonProfile(profileResponse);
  } finally {
    profileTimeout.close();
  }
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const name = cleanText(source.name);
  const shortName = cleanText(source.short_name);
  const avatarUrl = typeof source.avatar_url === "string" && source.avatar_url.trim() !== "" ? source.avatar_url : null;
  let avatar: CanvasProfileMetadata["avatar"] = null;
  let avatarBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  if (avatarUrl !== null) {
    const downloaded = await downloadAvatar(avatarUrl, fetchImpl, timeoutMs, onStatus);
    avatarBytes = downloaded.bytes;
    avatar = { path: path.basename(avatarOutputPath), contentType: downloaded.contentType, bytes: downloaded.bytes.length };
  }
  const metadata: CanvasProfileMetadata = { name, short_name: shortName, avatar };
  const staged: StagedFile[] = [];
  try {
    onStatus("staging local Canvas profile");
    staged.push(await stageFile(profileOutputPath, new TextEncoder().encode(`${JSON.stringify(metadata)}\n`)));
    if (avatar !== null) staged.push(await stageFile(avatarOutputPath, avatarBytes));
    await commitFiles(staged);
  } catch (error) {
    await Promise.all(staged.map((file) => unlink(file.temporary).catch(() => undefined)));
    throw error;
  }
  onStatus("Canvas profile sync committed");
  return { profile: metadata, avatarDownloaded: avatar !== null, avatarBytes: avatarBytes.length, avatarContentType: avatar?.contentType ?? null };
}

function avatarPath(profileFile: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value !== path.basename(value)) return null;
  const resolved = path.resolve(path.dirname(profileFile), value);
  return resolved === path.join(path.dirname(profileFile), path.basename(value)) ? resolved : null;
}

export async function readValidatedLocalCanvasProfile(profileFile: string): Promise<ValidatedLocalCanvasProfile | null> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(profileFile, "utf8")) as unknown; } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const displayName = cleanText(record.name) ?? cleanText(record.short_name);
  if (displayName === null) return null;
  const avatar = typeof record.avatar === "object" && record.avatar !== null && !Array.isArray(record.avatar) ? record.avatar as Record<string, unknown> : null;
  const type = contentType(typeof avatar?.contentType === "string" ? avatar.contentType : null);
  const candidate = avatarPath(profileFile, avatar?.path);
  if (type === null || candidate === null) return { displayName, avatarFilePath: null, avatarContentType: null };
  let image: Uint8Array;
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_AVATAR_BYTES) return { displayName, avatarFilePath: null, avatarContentType: null };
    image = await readFile(candidate);
  } catch {
    return { displayName, avatarFilePath: null, avatarContentType: null };
  }
  return hasImageSignature(image, type)
    ? { displayName, avatarFilePath: candidate, avatarContentType: type }
    : { displayName, avatarFilePath: null, avatarContentType: null };
}
