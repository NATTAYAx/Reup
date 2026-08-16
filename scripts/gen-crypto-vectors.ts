/**
 * Generates shared/crypto-vectors.json. Run it with:
 *
 *   pnpm gen:crypto-vectors
 *
 * WHY THIS EXISTS, AND WHY IT IS DIFFERENT FROM THE MERGE VECTORS
 *
 * The merge vectors check that two implementations of a rule agree. These check
 * something narrower and harsher: that bytes written by one are readable by the
 * other. There is no "close enough" — a frame that is off by one byte, a nonce
 * read from the wrong offset, an AAD assembled with a different separator, and
 * every blob fails to authenticate.
 *
 * That failure mode is the reason this file is worth the trouble. An encryption
 * mismatch between the two apps does not show up as a wrong answer. It shows up
 * as sync appearing to work — files listed, downloaded, no crash — while every
 * single one is rejected, and the two devices stay silently empty of each
 * other's data. Without a vector file that would be debugged over the network,
 * against a phone, through OAuth, with no way to tell which of five layers is
 * lying.
 *
 * WHY THE NONCES ARE FIXED
 *
 * seal() picks a random nonce, which is correct and makes output different
 * every run. A vector file that changes every run cannot be committed, cannot
 * be diffed, and cannot be pinned by a hash. So this uses sealWithNonce with
 * counted nonces, which is safe here for the one reason it is never safe in the
 * app: this key exists only inside this file and encrypts nothing real.
 *
 * WHAT THE NEGATIVE CASES ARE FOR
 *
 * Half the value is proving Kotlin REFUSES the right things. An implementation
 * that decrypts happily but ignores the AAD passes every positive case and is
 * still broken, because the binding to the filename is what stops whoever holds
 * the storage from replaying an old blob into a new slot. So the file records
 * what must fail as well as what must succeed.
 */

import {
  sealWithNonce,
  open,
  base64url,
  encodePairing,
  type Pairing,
} from "../src/lib/sync/crypto";

declare const require: (m: string) => {
  writeFileSync(p: string, d: string): void;
  mkdirSync(p: string, o: { recursive: boolean }): void;
};
declare const process: { argv: string[]; exit(code: number): void };

const enc = new TextEncoder();

/** Fixed and fake. Never used for anything, so it can be written down. */
const KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const OTHER_KEY = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);
const BUCKET = "vector-bucket-0001";

function nonce(n: number): Uint8Array {
  return new Uint8Array(12).map((_, i) => (n * 31 + i) & 0xff);
}

interface PositiveCase {
  id: string;
  bucketId: string;
  device: string;
  seq: number;
  plaintextUtf8: string;
  blobB64: string;
}

interface NegativeCase {
  id: string;
  why: string;
  bucketId: string;
  device: string;
  seq: number;
  blobB64: string;
  /** "auth" | "version" | "format" — the reason the reader must report. */
  expect: string;
}

async function build(): Promise<{ positive: PositiveCase[]; negative: NegativeCase[] }> {
  const bodies: [string, string][] = [
    ["empty", ""],
    ["ascii", `{"version":1,"changes":[]}`],
    // Thai, because a length computed in characters rather than bytes is a bug
    // that only ever shows up on the user's own data.
    ["thai", `{"name":"ยาความดัน","note":"เช้า 09:00"}`],
    ["emoji", `{"emoji":"🎯","goal":"เก็บเงิน"}`],
    // Longer than one AES block and not a multiple of 16, so any accidental
    // assumption about padding shows up here.
    ["long", "x".repeat(1000) + "ปิดท้าย"],
  ];

  const positive: PositiveCase[] = [];
  let n = 0;
  for (const [tag, body] of bodies) {
    for (const [device, seq] of [
      ["phone", 1],
      ["laptop", 4096],
    ] as [string, number][]) {
      const blob = await sealWithNonce(KEY, BUCKET, device, seq, enc.encode(body), nonce(n++));
      positive.push({
        id: `seal-${tag}-${device}-${seq}`,
        bucketId: BUCKET,
        device,
        seq,
        plaintextUtf8: body,
        blobB64: base64url(blob),
      });
    }
  }

  const base = await sealWithNonce(KEY, BUCKET, "phone", 7, enc.encode("secret"), nonce(999));

  const flipped = base.slice();
  flipped[base.length - 1] ^= 0x01;
  const truncated = base.slice(0, base.length - 1);
  const futureVersion = base.slice();
  futureVersion[4] = 0x02;
  const badMagic = base.slice();
  badMagic[0] = 0x58;

  const negative: NegativeCase[] = [
    {
      id: "moved-to-another-seq",
      why: "the AAD binds a blob to its filename; renaming it must not verify",
      bucketId: BUCKET,
      device: "phone",
      seq: 8,
      blobB64: base64url(base),
      expect: "auth",
    },
    {
      id: "moved-to-another-device",
      why: "same binding, other half of the filename",
      bucketId: BUCKET,
      device: "laptop",
      seq: 7,
      blobB64: base64url(base),
      expect: "auth",
    },
    {
      id: "another-bucket",
      why: "a blob from someone else's folder must not open in this one",
      bucketId: "some-other-bucket",
      device: "phone",
      seq: 7,
      blobB64: base64url(base),
      expect: "auth",
    },
    {
      id: "one-flipped-bit",
      why: "the tag exists to catch exactly this",
      bucketId: BUCKET,
      device: "phone",
      seq: 7,
      blobB64: base64url(flipped),
      expect: "auth",
    },
    {
      id: "truncated",
      why: "a half-uploaded file must not half-decrypt",
      bucketId: BUCKET,
      device: "phone",
      seq: 7,
      blobB64: base64url(truncated),
      expect: "auth",
    },
    {
      id: "future-version",
      why: "refuse rather than guess; a hopeful decrypt writes nonsense to disk",
      bucketId: BUCKET,
      device: "phone",
      seq: 7,
      blobB64: base64url(futureVersion),
      expect: "version",
    },
    {
      id: "not-a-reup-blob",
      why: "someone else's file in the same folder is not an error, but it is not ours",
      bucketId: BUCKET,
      device: "phone",
      seq: 7,
      blobB64: base64url(badMagic),
      expect: "format",
    },
  ];

  return { positive, negative };
}

(async () => {
  const { positive, negative } = await build();

  // Never emit a file this side cannot read back. A vector file generated from
  // a broken sealer is a spec that is wrong, and the port would pass against it.
  const dec = new TextDecoder();
  for (const c of positive) {
    const bytes = Uint8Array.from(atob(c.blobB64.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
      ch.charCodeAt(0),
    );
    const back = dec.decode(await open(KEY, c.bucketId, c.device, c.seq, bytes));
    if (back !== c.plaintextUtf8) {
      console.log(`FAILED — ${c.id} does not round-trip in the generator itself`);
      process.exit(1);
    }
  }

  const out = process.argv[2] ?? "../reup-shared/crypto-vectors.json";
  const fs = require("node:fs");
  const dir = out.replace(/[\\/][^\\/]*$/, "");
  if (dir && dir !== out) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        version: 1,
        generatedBy: "gen-crypto-vectors.ts",
        note: "Fake key. Encrypts nothing real. Safe to commit.",
        keyB64: base64url(KEY),
        otherKeyB64: base64url(OTHER_KEY),
        samplePairing: encodePairing({ bucketId: BUCKET, key: KEY } satisfies Pairing),
        positive,
        negative,
      },
      null,
      2,
    ),
  );

  console.log(`positive cases        ${positive.length}`);
  console.log(`negative cases        ${negative.length}`);
  console.log(`written               ${out}`);
  console.log("clean");
})();