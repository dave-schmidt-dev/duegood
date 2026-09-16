export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json(
        { status: "ok", authentication: "disabled" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (url.pathname === "/api/auth/status") {
      return Response.json(
        { available: false, reason: "not_configured" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
