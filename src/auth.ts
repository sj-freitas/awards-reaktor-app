import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

export function sign(value: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(value).digest("base64url");
  return `${value}.${mac}`;
}

export function unsign(signed: string | undefined, secret: string): string | null {
  if (!signed) return null;
  const dot = signed.lastIndexOf(".");
  if (dot < 0) return null;
  const value = signed.slice(0, dot);
  const expected = Buffer.from(sign(value, secret));
  const actual = Buffer.from(signed);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return value;
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export function setCookie(res: Response, name: string, value: string, maxAgeMs: number, secure: boolean) {
  res.cookie(name, value, { httpOnly: true, sameSite: "lax", secure, maxAge: maxAgeMs, path: "/" });
}

export function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

export function adminCookieValue(email: string, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ email, exp: now + ADMIN_TTL_MS })).toString("base64url");
  return sign(payload, secret);
}

export function readAdminEmail(cookie: string | undefined, secret: string, now = Date.now()): string | null {
  const payload = unsign(cookie, secret);
  if (!payload) return null;
  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof email === "string" && typeof exp === "number" && exp > now ? email : null;
  } catch {
    return null;
  }
}

export { ADMIN_TTL_MS };

export function googleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function fetchGoogleEmail(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<string | null> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return null;
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token?: string };
  if (!accessToken) return null;

  const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!userRes.ok) return null;
  const user = (await userRes.json()) as { email?: string; email_verified?: boolean };
  return user.email && user.email_verified === true ? user.email.toLowerCase() : null;
}
