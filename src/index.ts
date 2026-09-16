import { loadAuthConfig } from "./config";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const authConfig = loadAuthConfig(env);

    if (url.pathname === "/health") {
      return Response.json(
        { status: "ok", authentication: authConfig.mode },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (url.pathname === "/api/auth/status") {
      if (authConfig.mode === "disabled") {
        // Detailed reason (authConfig.reason) stays server-side only: it would otherwise let an
        // unauthenticated caller distinguish "misconfigured secret" from "key version conflict".
        return Response.json(
          { available: false, reason: "not_configured" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        { available: true, institution: authConfig.institutionOrigin },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
