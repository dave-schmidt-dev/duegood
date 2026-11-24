const MAX_REQUEST_BYTES = 256;

/** Read one bounded local broker command with an exact, allowlisted shape. */
export function readCommand(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const finish = (error, value) => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.setTimeout(0);
      error ? reject(error) : resolve(value);
    };
    const onError = () => finish(new Error("SOCKET_READ_FAILED"));
    const onEnd = () => finish(new Error("INCOMPLETE_REQUEST"));
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) return finish(new Error("REQUEST_TOO_LARGE"));
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) return finish(new Error("MULTIPLE_REQUESTS_REJECTED"));
      let request;
      const rawRequest = buffer.subarray(0, newline).toString("utf8");
      try { request = JSON.parse(rawRequest); } catch { return finish(new Error("INVALID_REQUEST")); }
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        return finish(new Error("INVALID_REQUEST"));
      }
      const keys = Object.keys(request);
      if (["status", "probe", "identity", "stop"].includes(request.command) && keys.length === 1) {
        if (rawRequest !== JSON.stringify({ command: request.command })) return finish(new Error("INVALID_REQUEST"));
        return finish(undefined, request);
      }
      if (request.command === "stop" && keys.length === 2 && Number.isSafeInteger(request.expectedPid)
          && request.expectedPid > 0) {
        if (rawRequest !== JSON.stringify({ command: "stop", expectedPid: request.expectedPid })) {
          return finish(new Error("INVALID_REQUEST"));
        }
        return finish(undefined, request);
      }
      if (request.command === "capture" && keys.includes("expectedUserId")
          && Number.isSafeInteger(request.expectedUserId) && request.expectedUserId > 0
          && (keys.length === 2 || (keys.length === 3 && request.requireHeadless === true))) {
        const expectedRequest = { command: "capture", expectedUserId: request.expectedUserId,
          ...(request.requireHeadless === true ? { requireHeadless: true } : {}) };
        if (rawRequest !== JSON.stringify(expectedRequest)) {
          return finish(new Error("INVALID_REQUEST"));
        }
        return finish(undefined, request);
      }
      finish(new Error("INVALID_REQUEST"));
    };
    socket.setTimeout(5_000, () => finish(new Error("REQUEST_TIMEOUT")));
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}
