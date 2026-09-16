import { handleAuthRoutes } from "./auth/routes";
import { loadAuthConfig } from "./config";
import { withSecurityHeaders } from "./security/headers";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const authConfig = loadAuthConfig(env);

    if (url.pathname === "/health") {
      return withSecurityHeaders(Response.json({ status: "ok", authentication: authConfig.mode }));
    }

    if (url.pathname === "/api/auth/status") {
      if (authConfig.mode === "disabled") {
        // Detailed reason (authConfig.reason) stays server-side only: it would otherwise let an
        // unauthenticated caller distinguish "misconfigured secret" from "key version conflict".
        return withSecurityHeaders(Response.json({ available: false, reason: "not_configured" }, { status: 503 }));
      }
      return withSecurityHeaders(
        Response.json({
          available: true,
          institution: authConfig.institutionOrigin,
          // Lets the disconnected recovery panel choose between the OAuth link and the
          // Personal-Access-Token form without exposing which specific OAuth field is missing.
          oauthConfigured: authConfig.clientId !== undefined && authConfig.clientSecret !== undefined,
        }),
      );
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      if (authConfig.mode === "disabled") {
        return withSecurityHeaders(Response.json({ error: "not_found" }, { status: 404 }));
      }
      return withSecurityHeaders(await handleAuthRoutes(request, authConfig, env.DB));
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
