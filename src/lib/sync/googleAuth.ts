// src/lib/sync/googleAuth.ts
//
// ─── the desktop half of signing in ──────────────────────────────────────────
//
// The three Rust commands, oauth.ts, and drive.ts, joined up. Nothing here
// decides anything: the challenge, the URL and the reading of the redirect are
// oauth.ts's, whose twin is OAuth.kt; the refreshing and the 401 dance are
// drive.ts's, whose twin is Drive.kt. This file is the order they happen in.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Db } from "./sqlLocalStore";
import type { HttpTransport } from "./storage";
import type { OAuthTokens, TokenStore } from "./drive";
import { GoogleTokenSource, tokensFromResponse, type AccessTokenSource } from "./drive";
import {
  DONE_PAGE, TOKEN_ENDPOINT, authUrl, challenge, exchangeBody,
  newState, newVerifier, parseRedirect,
} from "./oauth";

/**
 * Where the Google tokens live, exported so that the one list of things a
 * backup may not carry can be built from it rather than from a string typed out
 * a second time.
 */
export const GOOGLE_TOKENS_KEY = "sync_google_tokens";

/** How long the browser has. Long enough to find a password, short enough that
 *  a tab closed without deciding does not leave a thread waiting for ever. */
const WAIT_SECS = 300;

/**
 * The client this build was given, or null.
 *
 * Null is the normal state for anyone who cloned the repository, because the
 * credentials live in src-tauri/.env which is not in it. The settings screen
 * already has the right words for that case and has had them since the Drive
 * layer was written: Drive is built and tested, but nothing can sign you in.
 */
export async function googleClient(): Promise<{ id: string; secret: string } | null> {
  try {
    const pair = await invoke<[string, string] | null>("oauth_client");
    return pair ? { id: pair[0], secret: pair[1] } : null;
  } catch {
    return null;
  }
}

/**
 * Tokens live in app_settings, beside the pairing code.
 *
 * WHY NOT THE WINDOWS CREDENTIAL MANAGER
 *
 * Because the pairing code is already here, and it is strictly the more
 * dangerous of the two. The refresh token opens a folder of blobs this app
 * encrypted; the pairing code is what decrypts them. Putting the weaker secret
 * behind a stronger lock while the stronger secret sits in a table would be
 * theatre — and worse, it would leave two stories about where secrets live,
 * which is how one of them ends up in a backup file by accident.
 *
 * app_settings is deliberately outside SYNC_TABLES and deliberately stripped
 * from exported backups, and both of those already had to be true for the
 * pairing code. The token inherits them for free.
 *
 * If that judgement is ever revisited, it should be revisited for both keys at
 * once, and this interface is the reason that is one file rather than a search.
 */
export class SettingsTokenStore implements TokenStore {
  constructor(private readonly db: Db) {}

  async load(): Promise<OAuthTokens | null> {
    const rows = await this.db.select<{ value: string }[]>(
      "SELECT value FROM app_settings WHERE key = ?",
      [GOOGLE_TOKENS_KEY],
    );
    if (rows.length === 0) return null;
    try {
      const o = JSON.parse(rows[0].value) as Partial<OAuthTokens>;
      if (typeof o.accessToken !== "string" || typeof o.expiresAtSec !== "number") return null;
      return {
        accessToken: o.accessToken,
        refreshToken: typeof o.refreshToken === "string" ? o.refreshToken : undefined,
        expiresAtSec: o.expiresAtSec,
      };
      // Unreadable reads as "not connected" rather than throwing. The recovery
      // is one button away, and a settings screen that cannot open because a
      // stored value went strange is worse than one that offers to reconnect.
    } catch {
      return null;
    }
  }

  async save(t: OAuthTokens): Promise<void> {
    await this.db.execute(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [GOOGLE_TOKENS_KEY, JSON.stringify(t)],
    );
  }

  async clear(): Promise<void> {
    await this.db.execute("DELETE FROM app_settings WHERE key = ?", [GOOGLE_TOKENS_KEY]);
  }
}

export type ConnectResult =
  | { kind: "connected" }
  /** The person pressed cancel. Not a fault, and must not be shown as one. */
  | { kind: "refused"; why: string }
  | { kind: "failed"; why: string };

/**
 * The whole sign-in, once.
 *
 * ORDER MATTERS IN ONE PLACE
 *
 * The port is bound before the browser is opened, not after. Opening first
 * leaves a window in which the browser can arrive at a port nobody is listening
 * on, and the failure is a page that cannot connect while this app waits
 * happily for five minutes.
 */
export async function connectGoogleDrive(
  db: Db,
  http: HttpTransport,
): Promise<ConnectResult> {
  const client = await googleClient();
  if (!client) {
    return { kind: "failed", why: "this build has no Google credentials" };
  }

  let port: number;
  try {
    port = await invoke<number>("oauth_listen");
  } catch (e) {
    return { kind: "failed", why: `could not open a local port: ${String(e)}` };
  }

  // No path. Google matches a loopback redirect on host and port only, so the
  // simplest form is the one with least to get wrong.
  const redirectUri = `http://127.0.0.1:${port}`;
  const verifier = newVerifier();
  const state = newState();

  try {
    await openUrl(
      authUrl({
        clientId: client.id,
        redirectUri,
        challenge: await challenge(verifier),
        state,
      }),
    );
  } catch (e) {
    return { kind: "failed", why: `could not open a browser: ${String(e)}` };
  }

  let url: string;
  try {
    const r = await invoke<{ url: string }>("oauth_wait", {
      timeoutSecs: WAIT_SECS,
      donePage: DONE_PAGE,
    });
    url = r.url;
  } catch (e) {
    return { kind: "failed", why: String(e) };
  }

  const redirect = parseRedirect(url, state);
  if (redirect.kind === "refused") {
    return {
      kind: "refused",
      why:
        redirect.error === "access_denied"
          ? "the sign-in was cancelled"
          : redirect.description ?? redirect.error,
    };
  }
  if (redirect.kind === "rejected") return { kind: "failed", why: redirect.why };

  const body = exchangeBody({
    clientId: client.id,
    clientSecret: client.secret,
    code: redirect.code,
    verifier,
    redirectUri,
  });

  const res = await http.send({
    method: "POST",
    url: TOKEN_ENDPOINT,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new TextEncoder().encode(body),
  });

  if (res.status < 200 || res.status >= 300) {
    // Google's message is often the only thing that says which of the four
    // things went wrong, so it is passed through rather than summarised.
    return { kind: "failed", why: `Google refused the exchange: ${bodyText(res.body)}` };
  }

  let parsed: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(bodyText(res.body));
  } catch {
    return { kind: "failed", why: "Google's answer was not readable" };
  }
  const tokens = tokensFromResponse(parsed, Math.floor(Date.now() / 1000));

  if (!tokens.refreshToken) {
    // Without one, this works for an hour and then asks to sign in again for
    // ever. It means access_type or prompt did not survive the URL, which is a
    // bug here rather than something for the person to retry.
    return { kind: "failed", why: "Google returned no refresh token" };
  }

  await new SettingsTokenStore(db).save(tokens);
  return { kind: "connected" };
}

/**
 * Forget the tokens on this machine.
 *
 * Deliberately not a call to Google's revoke endpoint. Revoking kills the grant
 * for every device that shares this client, so disconnecting the desktop would
 * silently sign the phone out too. Unhooking one machine is what this button
 * looks like it does, so it is what it does; the whole grant can be dropped
 * from the Google account page, which is the place that shows what else it
 * would affect.
 */
export async function disconnectGoogleDrive(db: Db): Promise<void> {
  await new SettingsTokenStore(db).clear();
}

/** Whether this machine has something to refresh with. */
export async function googleConnected(db: Db): Promise<boolean> {
  const t = await new SettingsTokenStore(db).load();
  return t?.refreshToken !== undefined;
}

function bodyText(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

/**
 * The refreshing half of Drive, or undefined when this machine has not signed in.
 *
 * Lives here rather than in config.ts on purpose. config.ts is loaded by
 * check-sync.ts under plain node, so it must not reach anything Tauri —
 * an import of this file from there took the whole 104-check suite down with a
 * module-not-found before it ran a single case. Passing the built source into
 * syncNow keeps that arrow pointing one way.
 */
export async function driveTokenSource(
  db: Db,
  http: HttpTransport,
): Promise<AccessTokenSource | undefined> {
  const client = await googleClient();
  if (!client) return undefined;
  const store = new SettingsTokenStore(db);
  if ((await store.load()) === null) return undefined;
  // The secret goes to both halves or neither. Handing it to the exchange and
  // not to the refresh is what made a connection last exactly one hour.
  return new GoogleTokenSource(http, client.id, store, undefined, client.secret);
}