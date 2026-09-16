/**
 * Instructure rejects requests with no `User-Agent` (403 "you have not provided a valid user
 * agent") — Workers' `fetch()` sends none by default, unlike curl. Every outbound call to a
 * Canvas endpoint (PAT verification, OAuth token exchange/revocation, the paginated course/
 * assignment client) must send this.
 */
export const CANVAS_USER_AGENT = "duegood-worker/1.0";
