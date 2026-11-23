import { timingSafeEqual } from "node:crypto";
import { env } from "./env";

const SESSION_MS = 8 * 3600_000;
export const COOKIE = "rega_session";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (data: string) =>
  new Bun.CryptoHasher("sha256", env.sessionSecret).update(data).digest("base64url");

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function checkCredentials(user: string, pass: string) {
  // Ambas as comparações sempre executam (sem curto-circuito).
  const u = safeEqual(user, env.adminUser);
  const p = safeEqual(pass, env.adminPass);
  return u && p;
}

export function createSession(user: string) {
  const payload = b64(JSON.stringify({ u: user, exp: Date.now() + SESSION_MS }));
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token: string | null | undefined): { u: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.exp > Date.now() ? { u: data.u } : null;
  } catch {
    return null;
  }
}

export function sessionFrom(req: Request) {
  return verifySession(req.headers.get("cookie")?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1]);
}

export const deviceAuthorized = (req: Request) =>
  safeEqual(req.headers.get("x-device-token") ?? "", env.deviceToken);

export function sessionCookie(token: string, maxAgeSec = SESSION_MS / 1000) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}

// Limitador simples de tentativas de login por IP
const attempts = new Map<string, { n: number; reset: number }>();
export function loginAllowed(ip: string, now = Date.now()) {
  const a = attempts.get(ip);
  if (!a || a.reset < now) { attempts.set(ip, { n: 1, reset: now + 60_000 }); return true; }
  return ++a.n <= 5;
}
