/**
 * The two Tauri IPC primitives the desktop transport needs, typed narrowly so `transport.ts`
 * never imports `@tauri-apps/api` itself. `app.ts` passes the real `invoke` and a `Channel`
 * factory; tests pass mocks. Command inputs are item IDs, prior values, owner preferences, generated
 * snapshot IDs, or an opaque one-use promotion proof. Paths and URLs never come from the webview.
 * Import with `import type` only.
 */

/** Calls one Rust command with camelCase arguments and resolves with its JSON result. */
export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Creates an IPC channel whose messages arrive in order at `onMessage`. The returned value is
 * passed as a command argument; Tauri serializes it to a channel reference.
 */
export type TauriChannelFactory = (onMessage: (message: unknown) => void) => object;
