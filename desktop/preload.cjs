const { contextBridge, ipcRenderer } = require("electron");

// A method per capability; no generic IPC, filesystem, shell or fetch bridge.
const call = async (method, input = {}) => {
  const result = await ipcRenderer.invoke(`contributor:${method}`, input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld(
  "contributor",
  Object.freeze({
    state: () => call("state"),
    inspect: (invitation) => call("inspect", { invitation }),
    chooseWorkspace: () => call("chooseWorkspace"),
    prepare: (input) => call("prepare", input),
    revoke: (contributionId) => call("revoke", { contributionId }),
    reveal: (contributionId) => call("reveal", { contributionId }),
    rename: (name) => call("rename", { name }),
  }),
);
