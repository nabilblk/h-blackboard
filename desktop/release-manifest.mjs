import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { z } from "zod";
const Manifest = z
  .object({
    schema: z.literal(1),
    product: z.literal("io.harakiri.contributor"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    sequence: z.number().int().positive(),
    protocol: z.number().int().positive(),
    platform: z.literal("darwin"),
    arch: z.enum(["arm64", "x64"]),
    filename: z
      .string()
      .regex(/^Harakiri-Desktop-[0-9.]+-macOS-(arm64|x64)\.dmg$/),
    size: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 ** 3),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    team: z.string().regex(/^[A-Z0-9]{10}$/),
    source: z.string().regex(/^[a-f0-9]{40,64}$/),
    issued: z.number().int().positive(),
    expires: z.number().int().positive(),
  })
  .strict();
export async function hashRelease(file) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const bytes of createReadStream(file)) {
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha256: hash.digest("hex"), size };
}
export function signRelease(input, pem) {
  const value = Manifest.parse(input),
    privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("Release signatures require an Ed25519 key.");
  const payload = Buffer.from(JSON.stringify(value));
  return {
    payload: payload.toString("base64"),
    signature: sign(null, payload, privateKey).toString("base64"),
  };
}
export async function verifyRelease(
  envelope,
  pem,
  file,
  { minimumSequence, arch, now = Date.now() },
) {
  z.object({
    payload: z
      .string()
      .max(8192)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    signature: z
      .string()
      .length(88)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
    .strict()
    .parse(envelope);
  const publicKey = createPublicKey(pem),
    bytes = Buffer.from(envelope.payload, "base64");
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verify(null, bytes, publicKey, Buffer.from(envelope.signature, "base64"))
  )
    throw new Error("Release signature does not match the trusted key.");
  const value = Manifest.parse(JSON.parse(bytes));
  if (
    !Number.isSafeInteger(minimumSequence) ||
    minimumSequence < 1 ||
    value.sequence < minimumSequence
  )
    throw new Error("Release rollback refused.");
  if (
    value.arch !== arch ||
    value.issued > now + 300000 ||
    value.expires < now ||
    value.expires <= value.issued ||
    value.expires - value.issued > 31 * 86400000
  )
    throw new Error(
      "Release is expired, premature, or for another architecture.",
    );
  const actual = await hashRelease(file);
  if (actual.sha256 !== value.sha256 || actual.size !== value.size)
    throw new Error("Installer bytes do not match the signed release.");
  return value;
}
