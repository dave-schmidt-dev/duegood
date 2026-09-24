import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { readValidatedLocalCanvasProfile } from "../canvas/profile-sync";
import type { LocalCourse } from "./coursework-store";
import {
  LOCAL_RESOURCE_PREFIX,
  courseFolderSlug,
  finalizeResources,
  projectConversations,
  projectCourseResources,
  projectRefreshes,
  type LocalConversationSnapshot,
  type LocalProfile,
  type LocalRefresh,
  type LocalResource,
} from "../shared/dashboard-projection";

type JsonObject = Record<string, unknown>;

function text(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length === 0 ? null : clean.slice(0, max);
}

async function jsonFile(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")) as unknown; } catch { return null; }
}

function entries(value: unknown, max = 1_000): JsonObject[] {
  return Array.isArray(value) ? value.slice(0, max).filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

function courseDirectory(root: string, folder: string | null): string | null {
  const slug = courseFolderSlug(folder);
  return slug === null ? null : path.join(root, "classes", slug);
}

/**
 * Reads the private Canvas exports next to the coursework document and projects them into the
 * loopback dashboard through the shared projection (`src/shared/dashboard-projection.ts`), which the
 * desktop webview also runs over the documents its Rust store returns.
 */
export class DashboardStore {
  readonly #root: string;

  constructor(courseworkFile: string) {
    this.#root = path.dirname(path.resolve(courseworkFile));
  }

  async profile(): Promise<LocalProfile | null> {
    const profile = await readValidatedLocalCanvasProfile(path.join(this.#root, "canvas-profile.json"));
    if (profile === null) return null;
    return profile.avatarFilePath === null
      ? { displayName: profile.displayName }
      : { displayName: profile.displayName, avatarPath: "/api/local/profile/avatar" };
  }

  async avatar(): Promise<{ readonly filePath: string; readonly contentType: string } | null> {
    const profile = await readValidatedLocalCanvasProfile(path.join(this.#root, "canvas-profile.json"));
    if (profile === null || profile.avatarFilePath === null || profile.avatarContentType === null) return null;
    return { filePath: profile.avatarFilePath, contentType: profile.avatarContentType };
  }

  async resources(courses: readonly LocalCourse[]): Promise<readonly LocalResource[]> {
    const resources: LocalResource[] = [];
    for (const course of courses) {
      const directory = courseDirectory(this.#root, course.folder);
      if (directory === null) continue;
      const base = path.join(directory, "canvas-export");
      const api = path.join(base, "api");
      const projected = projectCourseResources(course, {
        downloadManifest: await jsonFile(path.join(base, "download-manifest.json")),
        files: await jsonFile(path.join(api, "files.json")),
        pages: await jsonFile(path.join(api, "pages.json")),
        modules: await jsonFile(path.join(api, "modules.json")),
        announcements: await jsonFile(path.join(api, "announcements.json")),
      }, LOCAL_RESOURCE_PREFIX);
      for (const resource of projected) resources.push(resource);
    }
    return finalizeResources(resources);
  }

  async refreshes(): Promise<readonly LocalRefresh[]> {
    return projectRefreshes(
      await jsonFile(path.join(this.#root, "coursework-refresh-history.json")),
      await jsonFile(path.join(this.#root, "canvas-conversations.json")),
    );
  }

  async conversations(): Promise<LocalConversationSnapshot> {
    return projectConversations(await jsonFile(path.join(this.#root, "canvas-conversations.json")));
  }

  async resolveLocalResource(resourceIdValue: string, courses: readonly LocalCourse[]): Promise<string | null> {
    const [courseId, type] = resourceIdValue.split(":", 3);
    if (type !== "file") return null;
    const course = courses.find((item) => item.id === courseId);
    const directory = courseDirectory(this.#root, course?.folder ?? null);
    if (course === undefined || directory === null) return null;
    const resources = await this.resources([course]);
    const resource = resources.find((item) => item.id === resourceIdValue && item.openPath !== null);
    if (resource === undefined) return null;
    const manifest = entries(await jsonFile(path.join(directory, "canvas-export", "download-manifest.json")));
    const marker = resourceIdValue.split(":").at(-1);
    const entry = manifest.find((item) => String(item.id) === marker && (item.status === "downloaded" || item.status === "reused"));
    const filename = text(entry?.filename, 180);
    if (filename === null || filename !== path.basename(filename)) return null;
    const materials = await realpath(path.join(directory, "materials")).catch(() => null);
    if (materials === null) return null;
    const candidate = await realpath(path.join(materials, filename)).catch(() => null);
    return candidate !== null && candidate.startsWith(`${materials}${path.sep}`) ? candidate : null;
  }
}
