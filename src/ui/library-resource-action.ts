/** Coordinates one native Library open/save request per resource ID. */
type LibraryResourceActionStatus = "opened" | "downloaded" | "cancelled" | "failed";

export interface LibraryResourceActionFeedback {
  readonly status: "pending" | LibraryResourceActionStatus;
  readonly message: string;
}

export interface LibraryResourceActionRunner {
  readonly isPending: (id: string) => boolean;
  readonly run: (id: string) => Promise<LibraryResourceActionFeedback> | undefined;
}

function outcome(action: "opened" | "downloaded" | "cancelled"): LibraryResourceActionFeedback {
  if (action === "opened") return { status: "opened", message: "File opened." };
  if (action === "downloaded") return { status: "downloaded", message: "File saved." };
  return { status: "cancelled", message: "Save cancelled." };
}

/**
 * Starts at most one request for each resource synchronously, before the native transport starts.
 * A completed request is removed so the same Library item can be retried.
 */
export function createLibraryResourceActionRunner(openResource: (id: string) => Promise<"opened" | "downloaded" | "cancelled">): LibraryResourceActionRunner {
  const pending = new Set<string>();
  return {
    isPending(id) { return pending.has(id); },
    run(id) {
      if (pending.has(id)) return undefined;
      pending.add(id);
      return openResource(id).then(outcome, (): LibraryResourceActionFeedback => ({ status: "failed", message: "The saved file could not be opened." })).finally(() => { pending.delete(id); });
    },
  };
}
