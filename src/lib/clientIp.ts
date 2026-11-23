import type { VercelRequest } from "@vercel/node";

/**
 * Returns the client's IP address for rate limiting.
 * The x-forwarded-for header can hold a comma-separated chain, so only the first entry is used.
 */
export function getClientIp(req: VercelRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "127.0.0.1";
}
