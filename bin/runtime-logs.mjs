import { open, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Writable } from "node:stream";

// One ordered, backpressure-aware writer per pipe. Keep the active file and
// three 10 MiB archives, so long-running or noisy runtimes cannot grow logs forever.
export async function runtimeLog(path, maxBytes = 10 * 1024 * 1024) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let file = await open(path, "a", 0o600);
  await file.chmod(0o600);
  let size = (await file.stat()).size;
  async function rotate() {
    await file.close();
    await unlink(path + ".3").catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    for (let i = 2; i >= 0; i--)
      await rename(i ? path + "." + i : path, path + "." + (i + 1)).catch(
        (e) => {
          if (e.code !== "ENOENT") throw e;
        },
      );
    file = await open(path, "a", 0o600);
    size = 0;
  }
  return new Writable({
    write(chunk, _encoding, done) {
      (async () => {
        for (let offset = 0; offset < chunk.length;) {
          if (size >= maxBytes) await rotate();
          const part = chunk.subarray(offset, offset + maxBytes - size);
          await file.writeFile(part);
          size += part.length;
          offset += part.length;
        }
      })().then(() => done(), done);
    },
    final(done) {
      file.close().then(() => done(), done);
    },
    destroy(error, done) {
      file.close().then(() => done(error), done);
    },
  });
}
