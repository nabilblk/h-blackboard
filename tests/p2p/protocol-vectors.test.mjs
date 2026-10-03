import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decode, encode } from "cborg";

const original = JSON.parse(
  await readFile(
    new URL("../../protocol/fixtures/genesis-v1.json", import.meta.url),
    "utf8",
  ),
);
const fixtures = [
  ...JSON.parse(
    await readFile(
      new URL("../../protocol/fixtures/governance-v8.json", import.meta.url),
      "utf8",
    ),
  ),
  ...JSON.parse(
    await readFile(
      new URL("../../protocol/fixtures/artifacts-v7.json", import.meta.url),
      "utf8",
    ),
  ),
  ...JSON.parse(
    await readFile(
      new URL("../../protocol/fixtures/work-v6.json", import.meta.url),
      "utf8",
    ),
  ),
  ...JSON.parse(
    await readFile(
      new URL("../../protocol/fixtures/communication-v5.json", import.meta.url),
      "utf8",
    ),
  ),
  { ...original, domain: "harakiri/event/1" },
  ...JSON.parse(
    await readFile(
      new URL("../../protocol/fixtures/scoped-v2.json", import.meta.url),
      "utf8",
    ),
  ),
];

for (const fixture of fixtures)
  test(`JavaScript verifies COSE ${fixture.domain} ${fixture.body.version ?? "claim"} and canonical payload`, () => {
    const domain = new TextEncoder().encode(fixture.domain);
    const signed = Buffer.from(fixture.cose_hex, "hex");
    const [protectedBytes, unprotected, payload, signature] = decode(signed, {
      useMaps: true,
    });
    const headers = decode(protectedBytes, { useMaps: true });
    assert.equal(headers.get(1), -8);
    assert.equal(headers.size, 2);
    assert.equal(unprotected.size, 0);
    assert.equal(
      Buffer.from(headers.get(4)).toString("hex"),
      fixture.public_key,
    );
    assert.deepEqual(decode(payload), fixture.body);
    assert.deepEqual(Buffer.from(encode(fixture.body)), Buffer.from(payload));
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(fixture.public_key, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    const signable = encode(["Signature1", protectedBytes, domain, payload]);
    assert.equal(verify(null, signable, publicKey, signature), true);
    const altered = Uint8Array.from(payload);
    altered[altered.length - 1] ^= 1;
    assert.equal(
      verify(
        null,
        encode(["Signature1", protectedBytes, domain, altered]),
        publicKey,
        signature,
      ),
      false,
    );
    assert.equal(
      verify(
        null,
        encode(["Signature1", protectedBytes, new Uint8Array(), payload]),
        publicKey,
        signature,
      ),
      false,
    );
  });
