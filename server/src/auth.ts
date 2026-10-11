import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { ApiError } from "./errors.js";

export interface AuthUser {
  userId: string;
  email: string;
}

export interface Auth {
  /** Verify a Supabase access token. Throws ApiError 401 when it is missing, expired or forged. */
  verify(token: string): Promise<AuthUser>;
}

const unauthorized = () => new ApiError(401, "unauthorized", "Sign in again.");

export function userFromClaims(p: JWTPayload): AuthUser {
  const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
  if (!p.sub || !email || p.role !== "authenticated") throw unauthorized();
  return { userId: p.sub, email };
}

/**
 * Supabase access tokens. New projects sign with asymmetric keys published at the JWKS URL; older projects use a
 * shared secret (HS256), which is accepted only when SUPABASE_JWT_SECRET is set.
 */
export function createSupabaseAuth(opts: { supabaseUrl: string; jwtSecret?: string }): Auth {
  const issuer = `${opts.supabaseUrl}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const secret = opts.jwtSecret ? new TextEncoder().encode(opts.jwtSecret) : null;

  return {
    async verify(token: string): Promise<AuthUser> {
      if (!token) throw unauthorized();
      let alg: string | undefined;
      try {
        alg = decodeProtectedHeader(token).alg;
      } catch {
        throw unauthorized();
      }
      try {
        const verifyOpts = { issuer, audience: "authenticated" };
        if (alg === "HS256") {
          if (!secret) throw unauthorized();
          return userFromClaims((await jwtVerify(token, secret, { ...verifyOpts, algorithms: ["HS256"] })).payload);
        }
        return userFromClaims((await jwtVerify(token, jwks, verifyOpts)).payload);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw unauthorized();
      }
    },
  };
}
