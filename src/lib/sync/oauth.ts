// src/lib/sync/oauth.ts
//
// ─── the half of signing in that is not platform-specific ────────────────────
//
// The mirror of shared/commonMain/kotlin/app/reup/sync/OAuth.kt. Every function
// here has a twin there and the two are held together by check-sync, because
// the whole point of the pair is that both devices attach to the same Drive
// folder with the same rules.
//
// WHY RUST DOES NOT DO THIS
//
// The desktop needs one thing the browser cannot do: bind a loopback port and
// wait for the redirect. That is a socket, and it lives in Rust for the same
// reason sync_http.rs does. Everything else — the challenge, the URL, reading
// what came back — is a decision, and putting decisions in a third language
// means a third copy to keep in agreement with the other two. Rust is handed a
// port and hands back a URL string. It does not know what OAuth is.

import { base64url } from "./crypto";

export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

/** RFC 3986 unreserved. The same set Drive.kt encodes against. */
const UNRESERVED =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";

/**
 * Percent-encoding that writes `%20` and never `+`.
 *
 * encodeURIComponent would do for most of this, but it leaves `!'()*` alone,
 * and the Kotlin side encodes them. Two encoders that agree on the common case
 * and differ on the rare one is exactly the shape of bug that shows up months
 * later on somebody else's machine. This is the same loop as DriveApi.encode.
 */
export function encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (UNRESERVED.includes(c)) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

const VERIFIER_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/**
 * A fresh PKCE verifier, 64 characters.
 *
 * Rejection sampling rather than `byte % 66`, because 256 does not divide by 66
 * and the remainder makes the first 58 characters of the alphabet slightly more
 * likely than the rest. A verifier that is slightly predictable does slightly
 * less than nothing.
 */
export function newVerifier(length = 64): string {
  if (length < 43 || length > 128) throw new Error("a verifier is 43 to 128 characters");
  const limit = 256 - (256 % VERIFIER_ALPHABET.length);
  let out = "";
  while (out.length < length) {
    const buf = new Uint8Array(length);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= limit) continue;
      out += VERIFIER_ALPHABET[b % VERIFIER_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * The S256 challenge: base64url of the SHA-256 of the verifier, unpadded.
 *
 * `plain` is in the spec too and Google accepts it. It sends the verifier as
 * the challenge, so anyone who sees the authorisation request can complete the
 * exchange — which is the thing PKCE exists to stop.
 */
export async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** A random `state`, only ever compared against itself. */
export function newState(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return base64url(b);
}

/**
 * The authorisation URL.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google return a
 * refresh token. Without offline there is none at all; without consent Google
 * skips the screen on a second grant and returns no refresh token *that time*,
 * which produces an app that works when first installed and stops working after
 * a reinstall. The pair is deliberate.
 */
export function authUrl(opts: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
}): string {
  const scope = opts.scope ?? DRIVE_SCOPE;
  return (
    AUTH_ENDPOINT +
    "?client_id=" + encode(opts.clientId) +
    "&redirect_uri=" + encode(opts.redirectUri) +
    "&response_type=code" +
    "&scope=" + encode(scope) +
    "&code_challenge=" + encode(opts.challenge) +
    "&code_challenge_method=S256" +
    "&state=" + encode(opts.state) +
    "&access_type=offline" +
    "&prompt=consent"
  );
}

/**
 * The body that trades the code for tokens.
 *
 * `clientSecret` is the desktop client's non-secret, which Google requires in
 * the request even though it is compiled into a binary anyone can read. On
 * Android there is none and the field is omitted entirely rather than sent
 * empty. The verifier is what is actually doing the work in both cases.
 */
export function exchangeBody(opts: {
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  clientSecret?: string;
}): string {
  let s = "client_id=" + encode(opts.clientId);
  if (opts.clientSecret) s += "&client_secret=" + encode(opts.clientSecret);
  s += "&code=" + encode(opts.code);
  s += "&code_verifier=" + encode(opts.verifier);
  s += "&redirect_uri=" + encode(opts.redirectUri);
  s += "&grant_type=authorization_code";
  return s;
}

export type RedirectResult =
  | { kind: "code"; code: string }
  /** Google said no, or the person did. `access_denied` is a cancel, not a fault. */
  | { kind: "refused"; error: string; description: string | null }
  | { kind: "rejected"; why: string };

/**
 * Read the redirect the browser came back with.
 *
 * THE STATE CHECK IS THE POINT
 *
 * A loopback port is reachable by anything running on this machine. So the
 * redirect is the one input in this file that does not come from Google — it
 * comes from whoever got there first, and a code from somewhere else exchanged
 * by this app attaches this person's Drive to an account that is not theirs.
 *
 * Compared whole, and a redirect with no state at all is refused rather than
 * treated as something being friendly.
 */
export function parseRedirect(url: string, expected: string): RedirectResult {
  const q = url.includes("?") ? url.slice(url.indexOf("?") + 1).split("#")[0] : "";
  if (q === "") return { kind: "rejected", why: "the redirect carried no query string" };

  const params = new Map<string, string>();
  for (const pair of q.split("&")) {
    if (pair === "") continue;
    const i = pair.indexOf("=");
    const k = i < 0 ? pair : pair.slice(0, i);
    const v = i < 0 ? "" : pair.slice(i + 1);
    // First wins. A duplicated parameter is somebody appending a second code to
    // a URL that already had one; the reading that lets that work is the one
    // where the last is used.
    if (!params.has(k)) params.set(k, percentDecode(v));
  }

  const state = params.get("state");
  if (state === undefined || state !== expected) {
    return { kind: "rejected", why: "this redirect did not come from the request this app made" };
  }

  const error = params.get("error");
  if (error !== undefined) {
    return { kind: "refused", error, description: params.get("error_description") ?? null };
  }

  const code = params.get("code");
  if (!code) return { kind: "rejected", why: "the redirect carried no code" };
  return { kind: "code", code };
}

/**
 * Query-string decoding, where `+` means a space.
 *
 * The opposite of `encode` above, and both are right: one is building a URL,
 * where a space is `%20`; this is reading form-encoded data, where a space may
 * be either. Browsers send both.
 */
export function percentDecode(s: string): string {
  if (!s.includes("%") && !s.includes("+")) return s;
  const out: number[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "+") {
      out.push(32);
      i++;
    } else if (c === "%" && i + 2 < s.length) {
      const hex = parseInt(s.slice(i + 1, i + 3), 16);
      if (Number.isNaN(hex)) {
        out.push(c.charCodeAt(0));
        i++;
      } else {
        out.push(hex);
        i += 3;
      }
    } else {
      for (const b of new TextEncoder().encode(c)) out.push(b);
      i++;
    }
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

/**
 * The page the browser is left looking at.
 *
 * Served by the Rust listener, which is why it is a plain string here rather
 * than a component: nothing in the app is running in that tab. It says to close
 * the tab because a browser tab that sits on a blank page after an OAuth
 * redirect is how people conclude that something went wrong.
 */
export const DONE_PAGE =
  "<!doctype html><meta charset=utf-8>" +
  "<title>Reup</title>" +
  "<body style=\"font:16px system-ui;padding:3rem;max-width:32rem;margin:auto\">" +
  "<p>Connected. You can close this tab and go back to Reup.</p>";