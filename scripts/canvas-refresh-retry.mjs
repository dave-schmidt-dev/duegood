import { isSignInReason } from "./canvas-sign-in-recovery.mjs";

/** Capture with one attended retry, preserving owner-started sessions. */
export async function captureWithSignInWindow({ ready, capture, start, stop, reportSignInWindow }) {
  const first = await capture();
  if (ready.headless !== true || first?.status !== "REQUEST_FAILED"
      || Object.keys(first).length !== 2 || !isSignInReason(first.errorCode)) return first;
  if ((await stop(ready.pid)).status !== "STOPPED") return { status: "STOP_FAILED" };
  reportSignInWindow(first.errorCode);
  const attended = await start({ headless: false });
  if (attended.status !== "READY") return { status: attended.status };
  if (attended.headless !== false) return { status: "START_FAILED" };
  let result;
  try {
    result = await capture();
  } finally {
    if (!attended.reused && (await stop(attended.pid)).status !== "STOPPED") result = { status: "STOP_FAILED" };
  }
  return result;
}

/** Return the content-free failure from an unsuccessful capture. */
export function captureFailureSummary(frame) {
  if (frame?.status === "REQUEST_FAILED" && Object.keys(frame).length === 2
      && Object.hasOwn(frame, "errorCode") && typeof frame.errorCode === "string"
      && /^[A-Z_]{1,48}$/u.test(frame.errorCode)) {
    return { status: "REQUEST_FAILED", errorCode: frame.errorCode };
  }
  if (frame && Object.keys(frame).length === 1
      && typeof frame.status === "string" && /^[A-Z0-9_]{1,48}$/u.test(frame.status)) {
    return { status: frame.status };
  }
  return { status: "REQUEST_FAILED", errorCode: "INVALID_RESPONSE" };
}
