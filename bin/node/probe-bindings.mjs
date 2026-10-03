// Optional G0 comparison. Install only in the ignored probe prefix:
// npm install --prefix var/node/bindings-probe --ignore-scripts @number0/iroh@1.1.0
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../var/node/bindings-probe/package.json", import.meta.url),
);
const bindings = require("@number0/iroh");
const alpn = [...Buffer.from("harakiri/bindings-proof/1")];
const endpoints = [];
try {
  for (const seed of [21, 22]) {
    const builder = bindings.Endpoint.builder();
    builder.applyMinimal();
    builder.secretKey(Array(32).fill(seed));
    builder.alpns([alpn]);
    builder.relayMode(bindings.RelayMode.disabled());
    endpoints.push(await builder.bind());
  }
  const [a, b] = endpoints;
  const accepted = (async () => {
    const incoming = await a.acceptNext();
    const connection = await (await incoming.accept()).connect();
    const stream = await connection.acceptBi();
    const bytes = await stream.recv.readToEnd(1024);
    await stream.send.writeAll(bytes);
    await stream.send.finish();
  })();
  const connection = await b.connect(a.addr(), alpn);
  const stream = await connection.openBi();
  const message = [...Buffer.from("Harakiri binding feasibility")];
  await stream.send.writeAll(message);
  await stream.send.finish();
  assert.deepEqual(await stream.recv.readToEnd(1024), message);
  await accepted;
  connection.close(0n, []);
  console.log(
    JSON.stringify(
      {
        package: "@number0/iroh@1.1.0",
        platform: `${process.platform}-${process.arch}`,
        encryptedExchange: "passed",
        vendorInfrastructure: "disabled",
        blobApiExported: Object.keys(bindings).some((key) => /blob/i.test(key)),
        gossipApiExported: Object.keys(bindings).some((key) =>
          /gossip/i.test(key),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.allSettled(endpoints.map((endpoint) => endpoint.close()));
}
