// ─── sync/transport.ts — the frontend's side of the Rust bridge ──────────────
//
// Nothing here decides anything. It converts a request into the shape the Rust
// command wants, calls it, and converts the answer back. Every judgement about
// WebDAV lives in storage.ts, where it is tested against fakes and never needs a
// network to be checked.
//
// WHY NOT fetch()
//
// The CSP in tauri.conf.json names three hosts in connect-src. A WebDAV URL is
// typed in by the user, so it can never be one of them, and the only way to
// make fetch reach it is widening connect-src to https://* — which grants every
// other line of frontend code permission to talk to anywhere in order to enable
// one feature. Around a hundred lines of Rust is cheaper than that.
//
// WHY BASE64 AND NOT A TYPED ARRAY
//
// Tauri's IPC is JSON. A Uint8Array crossing it becomes an array of numbers,
// which is roughly four bytes on the wire for every byte of payload and turns
// binary into something a middle layer might try to be clever about. Base64 is
// a third of the size and is exactly what the Rust side expects.
//
// Note this is standard base64, not the base64url in crypto.ts. They are not
// interchangeable and mixing them corrupts one byte in about every twelve — a
// failure that looks intermittent and random, which is the worst way for it to
// look.

import { invoke } from "@tauri-apps/api/core";
import { StorageError, type HttpRequest, type HttpResponse, type HttpTransport } from "./storage";

interface RustRequest {
  method: string;
  url: string;
  headers: [string, string][];
  bodyB64: string | null;
}

interface RustResponse {
  status: number;
  bodyB64: string;
}

interface RustError {
  kind: string;
  message: string;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  // Chunked because String.fromCharCode with a spread of a large array
  // overflows the call stack somewhere above about 100k arguments, and a blob
  // big enough to hit that is exactly the one nobody tests with.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isRustError(e: unknown): e is RustError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export class TauriHttpTransport implements HttpTransport {
  async send(req: HttpRequest): Promise<HttpResponse> {
    const payload: RustRequest = {
      method: req.method,
      url: req.url,
      // A record would lose duplicate header names. None are sent today, but
      // the tuple form costs nothing and does not have to be revisited.
      headers: Object.entries(req.headers),
      bodyB64: req.body ? toB64(req.body) : null,
    };

    let res: RustResponse;
    try {
      res = await invoke<RustResponse>("sync_request", { req: payload });
    } catch (e) {
      // Only wire failures arrive here. Anything with a status code — 401, 404,
      // 500 — comes back as a normal response, because those are answers the
      // caller knows how to act on and an exception would flatten them into a
      // string.
      if (isRustError(e)) {
        const kind = e.kind === "config" ? "config" : "network";
        throw new StorageError(e.message, kind);
      }
      throw new StorageError(String(e), "network");
    }

    return { status: res.status, body: fromB64(res.bodyB64) };
  }
}