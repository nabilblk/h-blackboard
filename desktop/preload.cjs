const { contextBridge, ipcRenderer } = require("electron");

const executionCall = async (method, input) => {
  const result = await ipcRenderer.invoke(`execution:${method}`, input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld(
  "blackboardExecution",
  Object.freeze({
    overview: (mission) => executionCall("executionOverview", { mission }),
    state: (contributionId) =>
      executionCall("executionState", { contributionId }),
    prepare: (contributionId) =>
      executionCall("executionPrepare", { contributionId }),
    login: (contributionId) =>
      executionCall("executionLogin", { contributionId }),
    signIn: (contributionId) =>
      executionCall("executionSignIn", { contributionId }),
    cancelSetup: (contributionId) =>
      executionCall("executionCancelSetup", { contributionId }),
    loginInput: (contributionId, text) =>
      executionCall("executionLoginInput", { contributionId, text }),
    cancelLogin: (contributionId) =>
      executionCall("executionCancelLogin", { contributionId }),
    openLogin: (contributionId, url) =>
      executionCall("executionOpenLogin", { contributionId, url }),
    start: (contributionId, grant) =>
      executionCall("executionStart", { contributionId, grant }),
    stop: (contributionId) =>
      executionCall("executionStop", { contributionId }),
    exportFiles: (contributionId) =>
      executionCall("executionExport", { contributionId }),
    exportDiagnostics: (contributionId) =>
      executionCall("executionDiagnostics", { contributionId }),
    importFiles: (contributionId) =>
      executionCall("executionImport", { contributionId }),
  }),
);
const setupCall = async (method, input = {}) => {
  const result = await ipcRenderer.invoke(`onboarding:${method}`, input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld(
  "blackboardSetup",
  Object.freeze({
    state: (mission) => setupCall("state", { mission }),
    appPreferences: () => setupCall("appPreferences"),
    completeMission: (input) => setupCall("completeMission", input),
    completionState: (mission) => setupCall("completionState", { mission }),
    discardCompletion: (id) => setupCall("discardCompletion", { id }),
    setBackground: (enabled) => setupCall("setBackground", { enabled }),
    setNotifications: (enabled) => setupCall("setNotifications", { enabled }),
    takeNotification: () => setupCall("takeNotification"),
    setCapacity: (maximum) => setupCall("setCapacity", { maximum }),
    journeyDiagnostics: () => setupCall("journeyDiagnostics"),
    setJourneyDiagnostics: (enabled) =>
      setupCall("setJourneyDiagnostics", { enabled }),
    clearJourneyDiagnostics: () => setupCall("clearJourneyDiagnostics"),
    agreements: (mission) => setupCall("agreements", { mission }),
    approveContribution: (input) => setupCall("approveContribution", input),
    cancelAgreement: (id) => setupCall("cancelAgreement", { id }),
    continueAgreement: (id) => setupCall("continueAgreement", { id }),
    reviewedStart: (input) => setupCall("reviewedStart", input),
    startState: (mission) => setupCall("startState", { mission }),
    cancelStart: (id) => setupCall("cancelStart", { id }),
    setup: (input) => setupCall("setup", input),
    permission: (input) => setupCall("permission", input),
    cancel: (id) => setupCall("cancel", { id }),
    preflight: () => setupCall("preflight"),
    installProvider: () => setupCall("installProvider"),
    cancelInstall: () => setupCall("cancelInstall"),
    takeInvitation: () => setupCall("takeInvitation"),
  }),
);

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

const nodeCall = async (method, input = {}) => {
  const result = await ipcRenderer.invoke(`node:${method}`, input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld(
  "blackboardNode",
  Object.freeze({
    state: () => nodeCall("state"),
    enroll: () => nodeCall("enroll"),
    createMission: (definition) => nodeCall("createMission", { definition }),
    updateInstructions: (mission, revision, definition) =>
      nodeCall("updateInstructions", { mission, revision, definition }),
    setCoordination: (mission, revision, mode) =>
      nodeCall("setCoordination", { mission, revision, mode }),
    consentGrant: (mission, grant, contributionId) =>
      nodeCall("consentGrant", { mission, grant, contributionId }),
    governance: (mission) => nodeCall("governance", { mission }),
    govern: (mission, control, action) =>
      nodeCall("govern", { mission, control, action }),
    missionAction: (mission, revision, action) =>
      nodeCall("missionAction", { mission, revision, action }),
    privateRecovery: (mission, audience) =>
      nodeCall("privateRecovery", { mission, audience }),
    reconcilePrivate: (mission, audience, member, revocation, accepted) =>
      nodeCall("reconcilePrivate", {
        mission,
        audience,
        member,
        revocation,
        accepted,
      }),
    setPlan: (mission, revision, text) =>
      nodeCall("setPlan", { mission, revision, text }),
    startMission: (mission, revision, readiness) =>
      nodeCall("startMission", { mission, revision, readiness }),
    observations: (mission) => nodeCall("observations", { mission }),
    pauseMission: (mission, revision, reason) =>
      nodeCall("pauseMission", { mission, revision, reason }),
    appointCoordinator: (mission, revision, contributionId) =>
      nodeCall("appointCoordinator", { mission, revision, contributionId }),
    workEvidence: (mission, event) =>
      nodeCall("workEvidence", { mission, event }),
    artifacts: (mission, query = {}) =>
      nodeCall("artifacts", { mission, query }),
    copyArtifactReference: (mission, revision) =>
      nodeCall("copyArtifactReference", { mission, revision }),
    artifactDetail: (mission, revision) =>
      nodeCall("artifactDetail", { mission, revision }),
    artifactAction: (mission, control, conversation, action) =>
      nodeCall("artifactAction", { mission, control, conversation, action }),
    artifactTransfer: (mission, transfer) =>
      nodeCall("artifactTransfer", { mission, transfer }),
    artifactOpen: (mission, revision, path) =>
      nodeCall("artifactOpen", { mission, revision, path }),
    artifactInspect: (mission, revision, path) =>
      nodeCall("artifactInspect", { mission, revision, path }),
    artifactSave: (mission, revision, path) =>
      nodeCall("artifactSave", { mission, revision, path }),
    workstreams: (mission) => nodeCall("workstreams", { mission }),
    tasks: (mission, query = {}) => nodeCall("tasks", { mission, query }),
    work: (mission, revision, action) =>
      nodeCall("work", { mission, revision, action }),
    agents: (mission, after = null) => nodeCall("agents", { mission, after }),
    shareAgent: (mission, contributionId, label) =>
      nodeCall("shareAgent", { mission, contributionId, label }),
    withdrawAgent: (mission, contributionId) =>
      nodeCall("withdrawAgent", { mission, contributionId }),
    directAgent: (mission, revision, registration, text) =>
      nodeCall("directAgent", { mission, revision, registration, text }),
    networkState: () => nodeCall("networkState"),
    configureNetwork: (config) => nodeCall("configureNetwork", { config }),
    discoveryState: () => nodeCall("discoveryState"),
    configureDiscovery: (config) => nodeCall("configureDiscovery", { config }),
    publishListing: (input) => nodeCall("publishListing", input),
    copyPeerTicket: () => nodeCall("copyPeerTicket"),
    withdrawMission: (mission) => nodeCall("withdrawMission", { mission }),
    reviewContribution: (mission, role) =>
      nodeCall("reviewContribution", { mission, role }),
    prepareContribution: (input) => nodeCall("prepareContribution", input),
    issueInvitation: (mission) => nodeCall("issueInvitation", { mission }),
    copyInvitation: (mission) => nodeCall("copyInvitation", { mission }),
    inspectInvitation: (ticket) => nodeCall("inspectInvitation", { ticket }),
    requestJoin: (ticket, reviewed_mission, reviewed_revision) =>
      nodeCall("requestJoin", { ticket, reviewed_mission, reviewed_revision }),
    localJoins: () => nodeCall("localJoins"),
    peers: (mission) => nodeCall("peers", { mission }),
    decideJoin: (mission, author, admit) =>
      nodeCall("decideJoin", { mission, author, admit }),
    revokeInvitations: (mission) => nodeCall("revokeInvitations", { mission }),
    revokeMember: (mission, author) =>
      nodeCall("revokeMember", { mission, author }),
    createAudience: (mission, readers) =>
      nodeCall("createAudience", { mission, readers }),
    audiences: (mission) => nodeCall("audiences", { mission }),
    openAgentConversation: (mission, registration) =>
      nodeCall("openAgentConversation", { mission, registration }),
    queryMessages: (mission, query) =>
      nodeCall("queryMessages", { mission, query }),
    markMessagesRead: (mission, ids) =>
      nodeCall("markMessagesRead", { mission, ids }),
    postMessage: (mission, text, audience = "main", to = null, thread = null) =>
      nodeCall("postMessage", { mission, text, audience, to, thread }),
    messages: (mission, before = null, audience = "main") =>
      nodeCall("messages", { mission, before, audience }),
  }),
);
