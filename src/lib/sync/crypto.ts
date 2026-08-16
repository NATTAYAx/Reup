// ─── sync/crypto.ts — the only thing between the data and a stranger ─────────
//
// Everything that leaves this machine goes through here first, and the storage
// on the other end is assumed hostile: not because Google or a NAS is expected
// to read it, but because designing on the assumption that they will not is how
// you end up owing strangers an apology.
//
// ─── WHAT THIS BUYS, WHICH IS MORE THAN PRIVACY ─────────────────────────────
//
// If the payload is encrypted here, "who stores it" stops being an
// architectural decision and becomes a setting. Google Drive, a NAS, a folder
// in Syncthing — all interchangeable, because none of them is trusted with
// anything in the first place. That is the whole reason there is no server to
// run, and therefore no permanent obligation to strangers' data.
//
// ─── AES-256-GCM, AND WHY NOT SOMETHING NEWER ───────────────────────────────
//
// XChaCha20-Poly1305 is the fashionable answer and it is a fine one. It is not
// the answer here because it needs a library on both sides, and AES-GCM is
// already native in both: WebCrypto in the WebView, javax.crypto on Android.
// A dependency that has to be audited and updated on two platforms, to replace
// something the platform already ships, is a cost with no matching benefit.
//
// ─── THE FRAME ──────────────────────────────────────────────────────────────
//
//   [0..4)    "REUP"                magic
//   [4]       0x01                  version
//   [5..17)   nonce                 12 random bytes
//   [17..)    ciphertext || tag     tag is the last 16 bytes
//
// Self-describing on purpose. A blob that cannot be read should say "I am a
// version you do not know" rather than decrypt into garbage, because garbage
// written back into a database is not recoverable and a refusal is.
//
// ─── AAD BINDS THE BLOB TO ITS SLOT, WHICH MATTERS MORE THAN IT SOUNDS ──────
//
// The additional data is `bucketId|device|seq` — the blob's own filename, in
// effect. It is not secret and it is not encrypted; it is authenticated, which
// means the tag stops verifying if the blob is moved.
//
// Without it, whoever controls the storage can rename files. Copy last month's
// `phone-4.reup` over `phone-91.reup` and every device replays a month-old
// state as if it were new — no key needed, nothing to decrypt, just a file
// copy. Rows come back from the dead and completions get undone. With the AAD
// that attack produces a decryption failure instead, which is loud.
//
// ─── NONCES ARE RANDOM, WHICH IS A CHOICE WITH A LIMIT ──────────────────────
//
// A counter would be smaller and would never repeat, but it has to be persisted
// and it has to survive a restore-from-backup, and a counter that silently
// rewinds after a restore is catastrophic: reusing a nonce with GCM does not
// leak one message, it leaks the authentication key.
//
// Random 96-bit nonces have a birthday bound instead, around 2^32 blobs per
// key. At a handful of blobs an hour that is longer than any of this will
// exist. A rewound counter is a cliff; this is a horizon.

const MAGIC = new Uint8Array([0x52, 0x45, 0x55, 0x50]); // "REUP"
const VERSION = 1;
const NONCE_BYTES = 12;
const HEADER_BYTES = MAGIC.length + 1 + NONCE_BYTES;
const KEY_BYTES = 32;

/** Thrown for anything a caller might reasonably want to tell apart from a bug. */
export class CryptoError extends Error {
  constructor(
    message: string,
    readonly kind: "format" | "version" | "auth" | "key",
  ) {
    super(message);
    this.name = "CryptoError";
  }
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new CryptoError("WebCrypto is unavailable", "key");
  return c.subtle;
}

/** The bytes the tag is computed over. Not secret; only authenticated. */
function aad(bucketId: string, device: string, seq: number): Uint8Array {
  return new TextEncoder().encode(`${bucketId}|${device}|${seq}`);
}

export function randomKey(): Uint8Array {
  const k = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(k);
  return k;
}

/** 128 bits. Not a secret — it only names the folder — so it can be short. */
export function randomBucketId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return base64url(b);
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(`key must be ${KEY_BYTES} bytes, got ${key.length}`, "key");
  }
  return subtle().importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(
  key: Uint8Array,
  bucketId: string,
  device: string,
  seq: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const nonce = new Uint8Array(NONCE_BYTES);
  globalThis.crypto.getRandomValues(nonce);
  return sealWithNonce(key, bucketId, device, seq, plaintext, nonce);
}

/**
 * Exported only so the vector generator can produce a file that is identical on
 * every run. Never call it from the app: a caller who supplies the nonce is a
 * caller who can repeat one, and repeating a nonce under GCM does not leak a
 * message, it leaks the key that authenticates all of them.
 */
export async function sealWithNonce(
  key: Uint8Array,
  bucketId: string,
  device: string,
  seq: number,
  plaintext: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== NONCE_BYTES) {
    throw new CryptoError(`nonce must be ${NONCE_BYTES} bytes`, "format");
  }
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad(bucketId, device, seq) as BufferSource },
      await importKey(key),
      plaintext as BufferSource,
    ),
  );
  const out = new Uint8Array(HEADER_BYTES + ct.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(nonce, MAGIC.length + 1);
  out.set(ct, HEADER_BYTES);
  return out;
}

export async function open(
  key: Uint8Array,
  bucketId: string,
  device: string,
  seq: number,
  blob: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length < HEADER_BYTES + 16) {
    throw new CryptoError("blob is too short to contain a frame", "format");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) throw new CryptoError("not a Reup blob", "format");
  }
  const v = blob[MAGIC.length];
  if (v !== VERSION) {
    // Deliberately not "try anyway". A future version might change the AAD or
    // the cipher, and a hopeful decrypt either fails loudly here or succeeds
    // into nonsense there.
    throw new CryptoError(`blob version ${v} is newer than this app understands`, "version");
  }
  const nonce = blob.subarray(MAGIC.length + 1, HEADER_BYTES);
  const ct = blob.subarray(HEADER_BYTES);
  try {
    return new Uint8Array(
      await subtle().decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad(bucketId, device, seq) as BufferSource },
        await importKey(key),
        ct as BufferSource,
      ),
    );
  } catch {
    // WebCrypto refuses to say which of these it was, and that is correct
    // behaviour, so the message says all of them rather than guessing one.
    throw new CryptoError(
      "blob failed to authenticate: wrong key, corrupted bytes, or moved to a different filename",
      "auth",
    );
  }
}

// ── pairing ──────────────────────────────────────────────────────────────────
//
// What the QR code on the desktop contains and the phone's camera reads.
//
// Short enough to stay a low-density QR that scans on a cracked screen in bad
// light, which is a real constraint and not a nicety: this is the one moment
// where a person is holding two devices and trying to make them agree, and it
// is the moment most likely to make them give up on sync entirely.
//
// A URI rather than JSON because a QR reader that recognises a scheme can hand
// it straight to the app, and because it survives being written on paper.

export interface Pairing {
  bucketId: string;
  key: Uint8Array;
}

export function encodePairing(p: Pairing): string {
  return `reup://pair?b=${p.bucketId}&k=${base64url(p.key)}`;
}

export function decodePairing(s: string): Pairing {
  const m = /^reup:\/\/pair\?b=([A-Za-z0-9_-]+)&k=([A-Za-z0-9_-]+)$/.exec(s.trim());
  if (!m) throw new CryptoError("not a pairing code", "format");
  const key = unbase64url(m[2]);
  if (key.length !== KEY_BYTES) throw new CryptoError("pairing code carries a bad key", "key");
  return { bucketId: m[1], key };
}

// ── base64url ────────────────────────────────────────────────────────────────
//
// Unpadded, because `=` has to be percent-encoded in a URI and a pairing code
// that survives being copied out of a chat window is worth four characters.

export function base64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unbase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}