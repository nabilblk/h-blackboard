import {
  readFile,
  writeFile,
  mkdir,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}
export const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};
export async function exclusive(file) {
  try {
    const lock = await open(file, "wx", 0o600);
    await lock.writeFile(String(process.pid));
    await lock.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(file, "utf8"));
    // An incomplete lock may belong to a process currently acquiring it.
    if (!pid || alive(pid))
      throw new Error("This launcher is already running or starting.");
    await unlink(file);
    return exclusive(file);
  }
  return async () => {
    if ((await readFile(file, "utf8").catch(() => "")) === String(process.pid))
      await unlink(file).catch(() => {});
  };
}
