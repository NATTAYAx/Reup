// ─── sync/drive.ts — Google Drive, the backend most people will actually use ─
//
// Same interface as WebDAV, same transport, same tests-with-a-fake. The only
// thing that differs is that Drive is a REST API instead of a filesystem, and
// that difference is entirely contained in this file.
//
// ─── WHY appDataFolder AND NOT AN ORDINARY FOLDER ───────────────────────────
//
// appDataFolder is a hidden per-application area inside the user's own Drive.
// Only the app that wrote there can read it, and it does not appear in the
// normal Drive interface, so nobody deletes a folder full of unreadable files
// six months from now while tidying up.
//
// The important part is the scope it needs. `drive.appdata` is classified
// non-sensitive by Google, which means basic app verification rather than the
// full sensitive-scope review with its demo video and multi-week wait. The
// alternative — asking for access to somebody's whole Drive to store our own
// files in it — is a restricted scope, needs a third-party security assessment,
// and deserves to.
//
// And the storage is the user's. Their quota, their account, their relationship
// with Google. There is no server here to run, pay for, or be responsible for.
//
// ─── WHAT MAKES DRIVE AWKWARD, AND HOW THAT IS CONTAINED ────────────────────
//
// Files are addressed by id, not by name, and names are not unique. The
// SyncStorage interface is name-based because a filesystem is, so this class
// keeps a name-to-id map filled in by list() and falls back to a targeted query
// when asked for something it has not seen.
//
// That is safe here specifically because the log is append-only and blobs are
// immutable. A name is written once and never rewritten, so a cached id can
// never point at stale contents — the worst case is that it points at a file
// that has since been deleted, which surfaces as a 404 and is handled.
//
// ─── PAGINATION IS NOT OPTIONAL ─────────────────────────────────────────────
//
// Drive returns a page at a time. Ignoring nextPageToken works perfectly during
// testing, when there are four files, and then quietly stops seeing older
// batches once a real log builds up — which reads as "sync forgot things from
// last month" and has no error attached to it.

import {
  StorageError,
  childUrl as _childUrl,
  type HttpResponse,
  type HttpTransport,
  type SyncStorage,
} from "./storage";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// The one scope this app asks for lives in oauth.ts, which is the only thing
// that uses it. It was declared here as well, exported, and imported by
// nobody — two copies of a string Google matches exactly, where the one that
// mattered was the other one. See DRIVE_SCOPE there.

// ─── tokens ──────────────────────────────────────────────────────────────────

export interface OAuthTokens {
  accessToken: string;
  /** Absent on a refresh response, which reuses the one already stored. */
  refreshToken?: string;
  /** Seconds since the epoch. Absolute, not a duration — see refreshDue. */
  expiresAtSec: number;
}

/**
 * Where tokens live between runs.
 *
 * An interface rather than a concrete store because the honest answer differs
 * per platform: the Windows Credential Manager on the desktop, EncryptedShared-
 * Preferences on Android. Neither belongs in a file that also knows about
 * multipart bodies.
 */
export interface TokenStore {
  load(): Promise<OAuthTokens | null>;
  save(t: OAuthTokens): Promise<void>;
  clear(): Promise<void>;
}

export interface AccessTokenSource {
  /** A token good for at least the next minute, refreshing if needed. */
  token(): Promise<string>;
  /** Force a refresh. Called once after a 401 before giving up. */
  refresh(): Promise<string>;
}

/**
 * Refresh a minute early rather than on expiry.
 *
 * A token that is valid when the request is built can be expired by the time it
 * arrives, and the resulting 401 is indistinguishable from a revoked grant. The
 * margin turns a race into arithmetic.
 */
export function refreshDue(expiresAtSec: number, nowSec: number): boolean {
  return expiresAtSec - nowSec < 60;
}

/** Google returns a duration; everything downstream wants a deadline. */
export function tokensFromResponse(
  json: { access_token?: string; refresh_token?: string; expires_in?: number },
  nowSec: number,
  previousRefresh?: string,
): OAuthTokens {
  if (!json.access_token) {
    throw new StorageError("the token response carried no access token", "auth");
  }
  return {
    accessToken: json.access_token,
    // A refresh response omits refresh_token. Overwriting the stored one with
    // undefined here is how an app silently loses the ability to refresh and
    // starts demanding a re-login every hour.
    refreshToken: json.refresh_token ?? previousRefresh,
    expiresAtSec: nowSec + (json.expires_in ?? 3600),
  };
}

/**
 * WHY THE SECRET IS HERE, AND WHY IT WAS NOT
 *
 * Google's client types split into public and confidential. Android and iOS
 * clients are public: no secret exists and none is sent, which is why the phone
 * has worked from the first day. A Desktop or Web client is confidential and
 * Google requires `client_secret` on every token call — not just the first one.
 *
 * `exchangeBody` has taken one since it was written, so connecting worked. This
 * did not, so the very first refresh failed with `client_secret is missing.`
 * and every one after it. Connecting again produced a fresh token that lasted
 * exactly one hour, which is why it looked like the connection kept "dropping"
 * rather than like a request that had never once succeeded.
 *
 * Optional, because the phone genuinely has no secret to send and sending an
 * empty one is its own error.
 */
export function refreshBody(
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
): Uint8Array {
  const form = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (clientSecret) form.set("client_secret", clientSecret);
  return new TextEncoder().encode(form.toString());
}

export class GoogleTokenSource implements AccessTokenSource {
  private cached: OAuthTokens | null = null;

  constructor(
    private readonly http: HttpTransport,
    private readonly clientId: string,
    private readonly store: TokenStore,
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
    /** Present for a confidential client, absent for a public one. */
    private readonly clientSecret?: string,
  ) {}

  async token(): Promise<string> {
    const t = (this.cached ??= await this.store.load());
    if (!t) throw new StorageError("Google Drive is not connected yet", "auth");
    if (!refreshDue(t.expiresAtSec, this.nowSec())) return t.accessToken;
    return this.refresh();
  }

  async refresh(): Promise<string> {
    const t = (this.cached ??= await this.store.load());
    if (!t?.refreshToken) {
      throw new StorageError("Google Drive needs to be connected again", "auth");
    }
    const res = await this.http.send({
      method: "POST",
      url: TOKEN_URL,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshBody(this.clientId, t.refreshToken, this.clientSecret),
    });
    if (res.status !== 200) {
      // ── WHY THIS NO LONGER THROWS THE GRANT AWAY ON ANY FAILURE ────────────
      //
      // A refresh token IS revoked when the app is removed, the password
      // changes, or it goes unused for six months — none worth retrying, so the
      // first version of this cleared the grant on any non-200 and asked the
      // person to sign in again.
      //
      // That was survivable while a sync only happened when somebody pressed a
      // button. It stopped being survivable the moment sync became automatic:
      // one timeout, one 500 from Google, one moment on a train, and the app
      // signs itself out — repeatedly, which is exactly how this was found.
      // The frequency did not create the bug, it just stopped hiding it.
      //
      // Google says which of the two it is. `invalid_grant` means the grant is
      // gone and asking again is the only way forward; a 429 or a 5xx means try
      // later, and clearing a working grant because a server was busy costs the
      // person a sign-in for nothing. It is the same distinction the request
      // path already draws between "you may not" and "you are going too fast",
      // one layer down and never applied here.
      const text = new TextDecoder().decode(res.body);
      // Google names the failure in the body. Carried into the message rather
      // than thrown away, because "400" on its own is the difference between a
      // dead grant, a malformed request and a client that has changed, and
      // those are three different things to do about it.
      let named = "";
      try {
        const j = JSON.parse(text) as { error?: string; error_description?: string };
        named = j.error_description || j.error || "";
      } catch {
        named = text.slice(0, 120);
      }

      // A 4xx from the token endpoint is always about this grant, never about
      // the weather. Only some of them mean the grant is gone for good, and
      // that is the ONLY case worth destroying it over — but every one of them
      // needs the person, so none of them may be reported as "trying again".
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        const dead = /invalid_grant|invalid_client|unauthorized_client/.test(text);
        if (dead) {
          await this.store.clear();
          this.cached = null;
        }
        throw new StorageError(
          named || "Google refused the refresh",
          "auth",
          res.status,
        );
      }

      // Everything else really is the weather. The refresh token is kept and
      // the next attempt reuses it.
      throw new StorageError(named || "Google could not refresh right now", "network", res.status);
    }
    const next = tokensFromResponse(
      JSON.parse(new TextDecoder().decode(res.body)),
      this.nowSec(),
      t.refreshToken,
    );
    await this.store.save(next);
    this.cached = next;
    return next.accessToken;
  }
}

// ─── request building, kept pure so it can be read and tested ────────────────

export function listUrl(pageToken?: string): string {
  const q = new URLSearchParams({
    spaces: "appDataFolder",
    // Without an explicit fields list Drive returns a large default projection
    // for every file. Two fields are all that is used.
    fields: "nextPageToken,files(id,name)",
    pageSize: "1000",
  });
  if (pageToken) q.set("pageToken", pageToken);
  return `${API}?${q.toString()}`;
}

export function findByNameUrl(name: string): string {
  // Built by hand rather than with URLSearchParams, which encodes a space as
  // `+` because it follows the form-encoding rules. Whether `+` means a space
  // or a literal plus in a query string depends on who is parsing it, and if
  // Drive reads it literally the clause becomes `name+=+'x'`, which matches
  // nothing. That failure is silent: the file is simply reported as missing,
  // and the sync quietly skips a batch.
  //
  // No spaces at all here, and encodeURIComponent for the rest, so there is
  // nothing left to disagree about.
  const clause = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}'`);
  return (
    `${API}?spaces=appDataFolder` +
    `&q=${clause}` +
    `&fields=${encodeURIComponent("files(id,name)")}` +
    "&pageSize=10"
  );
}

/**
 * A multipart/related body: JSON metadata, then the bytes.
 *
 * Drive's simple upload takes content but cannot set a name, and the resumable
 * flow is two extra round trips for files measured in kilobytes. Multipart is
 * the one that does both in one request.
 *
 * The boundary is passed in rather than generated so tests are deterministic.
 * It has to be a string that does not appear in the payload; a random one from
 * a 128-bit source will not, and a fixed one in production eventually would.
 */
export function multipartBody(name: string, bytes: Uint8Array, boundary: string): Uint8Array {
  const meta = JSON.stringify({ name, parents: ["appDataFolder"] });
  const head = new TextEncoder().encode(
    `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${meta}\r\n` +
      `--${boundary}\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}

interface DriveFile {
  id: string;
  name: string;
}

export function parseFileList(body: Uint8Array): { files: DriveFile[]; nextPageToken?: string } {
  let json: { files?: DriveFile[]; nextPageToken?: string };
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new StorageError("Drive returned something that was not JSON", "server");
  }
  return { files: json.files ?? [], nextPageToken: json.nextPageToken };
}

// ─── the adapter ─────────────────────────────────────────────────────────────

export class GoogleDriveStorage implements SyncStorage {
  /** Filled by list(). Safe to cache only because blobs are immutable. */
  private ids = new Map<string, string>();

  constructor(
    private readonly http: HttpTransport,
    private readonly tokens: AccessTokenSource,
    private readonly newBoundary: () => string = randomBoundary,
  ) {}

  /**
   * Every Drive call goes through here, so the 401 dance exists in one place.
   *
   * Exactly one retry. A loop would turn a permanently revoked grant into an
   * infinite one, and Google answers a revoked refresh token quickly enough
   * that the loop would be tight.
   */
  private async call(
    method: string,
    url: string,
    body?: Uint8Array,
    contentType?: string,
  ): Promise<HttpResponse> {
    const attempt = async (token: string) =>
      this.http.send({
        method,
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(contentType ? { "Content-Type": contentType } : {}),
        },
        body,
      });

    let res = await attempt(await this.tokens.token());
    if (res.status === 401) res = await attempt(await this.tokens.refresh());

    if (res.status === 401 || res.status === 403) {
      const text = new TextDecoder().decode(res.body);
      // 403 is overloaded: it is both "you may not" and "you are going too
      // fast". Only the first is an auth problem, and telling someone to
      // reconnect their account when the real answer is to wait a minute is a
      // small betrayal that costs them their afternoon.
      if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(text)) {
        throw new StorageError("Google is rate-limiting; try again shortly", "network", 403);
      }
      throw new StorageError("Google Drive refused the request", "auth", res.status);
    }
    if (res.status === 404) throw new StorageError("not found in Drive", "notFound", 404);
    if (res.status >= 500) throw new StorageError(`Drive failed (${res.status})`, "server", res.status);
    if (res.status >= 400) throw new StorageError(`Drive rejected the request (${res.status})`, "server", res.status);
    return res;
  }

  async list(): Promise<string[]> {
    const names: string[] = [];
    this.ids.clear();
    let pageToken: string | undefined;
    let guard = 0;
    do {
      const res = await this.call("GET", listUrl(pageToken));
      const page = parseFileList(res.body);
      for (const f of page.files) {
        // Drive allows two files with the same name. The log never writes a
        // name twice, but a PUT that timed out after the server committed it
        // and was then retried would leave a duplicate. Both copies hold
        // identical bytes, because blobs are immutable, so keeping the first
        // and ignoring the rest is correct rather than merely convenient.
        if (!this.ids.has(f.name)) {
          this.ids.set(f.name, f.id);
          names.push(f.name);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken && ++guard < 100);
    return names;
  }

  private async idFor(name: string): Promise<string> {
    const cached = this.ids.get(name);
    if (cached) return cached;
    const res = await this.call("GET", findByNameUrl(name));
    const found = parseFileList(res.body).files.find((f) => f.name === name);
    if (!found) throw new StorageError(`${name} is not in Drive`, "notFound", 404);
    this.ids.set(name, found.id);
    return found.id;
  }

  async get(name: string): Promise<Uint8Array> {
    const id = await this.idFor(name);
    // alt=media is what makes this return the bytes instead of the metadata.
    // Without it the response is a small JSON object that decrypts to nothing
    // and reports a corrupted blob.
    const res = await this.call("GET", `${API}/${encodeURIComponent(id)}?alt=media`);
    return res.body;
  }

  async put(name: string, bytes: Uint8Array): Promise<void> {
    // Always a create. appDataFolder needs no MKCOL — it exists as soon as the
    // scope is granted — and the log never rewrites a name, so there is no
    // update path to get wrong.
    const boundary = this.newBoundary();
    const res = await this.call(
      "POST",
      `${UPLOAD}?uploadType=multipart&fields=id,name`,
      multipartBody(name, bytes, boundary),
      `multipart/related; boundary=${boundary}`,
    );
    const created = JSON.parse(new TextDecoder().decode(res.body)) as DriveFile;
    if (created?.id) this.ids.set(name, created.id);
  }

  async delete(name: string): Promise<void> {
    let id: string;
    try {
      id = await this.idFor(name);
    } catch (e) {
      // Already gone is the outcome that was wanted. Two devices compacting the
      // same old batch at once must not produce a failure anybody sees.
      if (e instanceof StorageError && e.kind === "notFound") return;
      throw e;
    }
    try {
      await this.call("DELETE", `${API}/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof StorageError && e.kind === "notFound") return;
      throw e;
    }
    this.ids.delete(name);
  }
}

function randomBoundary(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return "reup" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Re-exported so callers can validate a name before it reaches Drive, using the
// same rule WebDAV uses. One naming rule, checked in one place.
export const assertSafeName = (name: string): void => void _childUrl("https://x/", name);