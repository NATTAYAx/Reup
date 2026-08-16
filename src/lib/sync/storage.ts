// ─── sync/storage.ts — the four things a place to put bytes must do ──────────
//
// The whole reason there is no server to run is that this interface is small
// enough for somebody else's storage to already satisfy it. Google Drive, a
// NAS over WebDAV, a folder inside Syncthing — none of them is trusted with
// anything, because the bytes arriving here have already been through
// crypto.ts, so "who stores it" is a setting rather than an architecture.
//
// Four methods. No query, no compare-and-swap, no server-side merge, no
// transactions. Every one of those would have been useful and every one would
// have narrowed the set of backends that could host this to roughly one.

export interface SyncStorage {
  /** Every file name in the folder, including ones we did not write. */
  list(): Promise<string[]>;
  get(name: string): Promise<Uint8Array>;
  /** Must create the folder if it is missing. Callers never think about that. */
  put(name: string, bytes: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly kind: "config" | "auth" | "notFound" | "network" | "server",
    readonly status?: number,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

// ─── the transport ───────────────────────────────────────────────────────────
//
// Deliberately not `fetch`.
//
// The CSP in tauri.conf.json lists three hosts in connect-src, and a WebDAV URL
// is typed in by the user, so it can never be one of them. Widening that to
// https://* to allow one feature would give every other line of frontend code
// permission to talk to anywhere, which is a poor trade for a feature that can
// just as easily go through Rust.
//
// Going through Rust also means the WebDAV password never has to enter
// JavaScript at all — see the note at the bottom of transport.ts.

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  body: Uint8Array;
}

export interface HttpTransport {
  send(req: HttpRequest): Promise<HttpResponse>;
}

// ─── WebDAV ──────────────────────────────────────────────────────────────────
//
// WHY WEBDAV IS BUILT FIRST WHEN ALMOST NOBODY WILL USE IT
//
// Google Drive is the one real people will pick: the account is already on the
// phone, it is two taps, and nobody has to know what a URL is. WebDAV asks a
// person to type a hostname, which most will not do.
//
// It is written first anyway, because it is the one that can be stood up
// locally in a single command with no OAuth in front of it. When Drive later
// fails — and it will, because OAuth has more ways to fail than the rest of
// this app combined — the question is always "is it my sync logic or is it my
// Google setup", and without something to compare against, that question takes
// a day.
//
// This is the same mistake as the wallpaper plugin, avoided in advance. A day
// went into debugging on the assumption that a library handled a hard Windows
// behaviour, and it did not. The fix was not better debugging, it was checking
// the assumption first. A boring backend that provably works is how the
// interesting one gets checked.

export interface WebDavConfig {
  /** Folder URL. A trailing slash is optional; it is normalised either way. */
  baseUrl: string;
  username: string;
  password: string;
}

/**
 * Plain http is refused for public hosts and allowed for private ones.
 *
 * The data is already encrypted, so http would not expose a single task name.
 * What it would expose is the WebDAV password, on every request, to anything on
 * the path — and people reuse passwords, so that is a bigger loss than the data
 * would have been.
 *
 * On a home network the threat is different in kind rather than in degree, and
 * plenty of NAS boxes only ever speak http on the LAN. Refusing those outright
 * would push someone toward turning the check off entirely, which is worse than
 * having no check.
 */
export function assertUsableUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new StorageError(`not a URL: ${raw}`, "config");
  }
  if (u.protocol === "https:") return u;
  if (u.protocol !== "http:") {
    throw new StorageError(`${u.protocol} is not supported, use https`, "config");
  }
  if (isPrivateHost(u.hostname)) return u;
  throw new StorageError(
    "plain http would send the password in the clear over the internet; use https",
    "config",
  );
}

export function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Base URL with exactly one trailing slash, so joining is never ambiguous. */
export function normaliseBase(raw: string): string {
  const u = assertUsableUrl(raw);
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${path}/`;
}

/**
 * Blob names are `[A-Za-z0-9_-]+-\d+.reup`, so none of them needs escaping.
 * The folder path might: somebody's NAS folder can be called "งานของฉัน".
 */
export function childUrl(base: string, name: string): string {
  if (!/^[A-Za-z0-9_.\-]+$/.test(name)) {
    throw new StorageError(`refusing to build a URL for the name "${name}"`, "config");
  }
  return normaliseBase(base) + name;
}

/**
 * Pull the file names out of a 207 Multi-Status body.
 *
 * Done with a regex rather than an XML parser, which needs justifying because
 * it is usually the wrong answer. The reasons it is the right one here: the
 * only thing being read is href, the response is machine-generated by a server
 * implementing a spec, and DOMParser does not exist on the Kotlin side, so an
 * XML dependency would have to be added to two platforms to read one element.
 *
 * The namespace prefix is left open on purpose. Nextcloud sends `<d:href>`,
 * Apache mod_dav sends `<D:href>`, some send `<href>` with a default xmlns, and
 * a parser that hardcodes any one of them works against exactly one server.
 *
 * Names that are not valid blob names fall out later in filesToFetch, so
 * collections and strangers' files need no special handling here — they simply
 * never match. That is why this can afford to be simple.
 */
export function parseMultiStatus(xml: string): string[] {
  const out: string[] = [];
  const re = /<(?:[A-Za-z0-9_.-]+:)?href\s*>([^<]*)<\/(?:[A-Za-z0-9_.-]+:)?href\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const href = m[1].trim();
    if (!href || href.endsWith("/")) continue; // collections, including the folder itself
    const last = href.split("/").filter(Boolean).pop();
    if (!last) continue;
    try {
      out.push(decodeURIComponent(last));
    } catch {
      out.push(last); // a badly encoded name is still a name
    }
  }
  return out;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

export class WebDavStorage implements SyncStorage {
  private readonly base: string;

  constructor(
    private readonly http: HttpTransport,
    private readonly cfg: WebDavConfig,
  ) {
    this.base = normaliseBase(cfg.baseUrl);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      // Basic is the only scheme every WebDAV server agrees on. It is not a
      // weakness here: the URL is already required to be https or private, and
      // this whole file is behind a Rust command so the header is assembled
      // outside the WebView.
      Authorization: "Basic " + btoa(`${this.cfg.username}:${this.cfg.password}`),
      ...extra,
    };
  }

  private check(res: HttpResponse, what: string): HttpResponse {
    if (res.status === 401 || res.status === 403) {
      throw new StorageError(`${what}: the server rejected the username or password`, "auth", res.status);
    }
    if (res.status === 404) {
      throw new StorageError(`${what}: not found`, "notFound", 404);
    }
    if (res.status >= 500) {
      throw new StorageError(`${what}: the server failed (${res.status})`, "server", res.status);
    }
    if (res.status >= 400) {
      throw new StorageError(`${what}: rejected (${res.status})`, "server", res.status);
    }
    return res;
  }

  async list(): Promise<string[]> {
    const res = await this.http.send({
      method: "PROPFIND",
      url: this.base,
      // Depth 1 is the folder and its direct children. Depth infinity is what
      // gets an account rate-limited, and there are no subfolders anyway.
      headers: this.headers({ Depth: "1", "Content-Type": 'application/xml; charset="utf-8"' }),
      body: new TextEncoder().encode(PROPFIND_BODY),
    });
    // An empty folder that does not exist yet is not an error. Nothing has been
    // written, so there is nothing to read, and saying so is the honest answer.
    if (res.status === 404) return [];
    this.check(res, "listing the folder");
    return parseMultiStatus(new TextDecoder().decode(res.body));
  }

  async get(name: string): Promise<Uint8Array> {
    const res = await this.http.send({
      method: "GET",
      url: childUrl(this.base, name),
      headers: this.headers(),
    });
    this.check(res, `reading ${name}`);
    return res.body;
  }

  async put(name: string, bytes: Uint8Array): Promise<void> {
    const send = () =>
      this.http.send({
        method: "PUT",
        url: childUrl(this.base, name),
        headers: this.headers({ "Content-Type": "application/octet-stream" }),
        body: bytes,
      });

    let res = await send();

    // 409 from a PUT means the parent collection is missing. Creating it here
    // rather than at setup time means there is no separate "connect" step that
    // can be half-finished, and no state where the app believes it is
    // configured but the folder was never made.
    if (res.status === 409 || res.status === 404) {
      await this.makeDir();
      res = await send();
    }
    this.check(res, `writing ${name}`);
  }

  async delete(name: string): Promise<void> {
    const res = await this.http.send({
      method: "DELETE",
      url: childUrl(this.base, name),
      headers: this.headers(),
    });
    // Already gone is the outcome that was wanted. Compaction deleting the same
    // old batch twice must not be an error, or two devices tidying up at once
    // turns into a failure the person sees.
    if (res.status === 404) return;
    this.check(res, `deleting ${name}`);
  }

  private async makeDir(): Promise<void> {
    const res = await this.http.send({
      method: "MKCOL",
      url: this.base,
      headers: this.headers(),
    });
    // 405 means it already exists, which is a success dressed as a failure.
    if (res.status === 405 || (res.status >= 200 && res.status < 300)) return;
    this.check(res, "creating the folder");
  }
}