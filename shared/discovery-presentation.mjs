export const discoveryOutcomes = {
  waiting: "Waiting to exchange briefs",
  contacting: "Contacting peer",
  ok: "Briefs exchanged",
  expired_address: "Address expired · ask this peer for a fresh address",
  route_blocked: "No permitted route · review network settings",
  unreachable:
    "Exchange failed · check the peer is online and on a compatible version",
  invalid_catalog: "Invalid catalog rejected",
  cache_error: "Could not save the received catalog",
};

export function discoveryPresentation({
  state,
  online,
  query = "",
  error = "",
  now = Date.now(),
}) {
  const search = query.trim().toLowerCase();
  const all = state?.listings.filter((v) => v.status !== "unlisted") ?? [];
  const visible = all.filter((v) =>
    `${v.advertisement.title} ${v.advertisement.summary} ${v.advertisement.capabilities.join(" ")}`
      .toLowerCase()
      .includes(search),
  );
  const peers = state?.health?.peers ?? [];
  const recent = peers.filter(
    (p) =>
      p.last_success_ms &&
      now - p.last_success_ms < 30000 &&
      ["ok", "contacting"].includes(p.outcome),
  ).length;
  const result = (title, detail, action = null) => ({
    title,
    detail,
    action,
    visible,
    recent,
    peers,
  });
  if (error)
    return result(
      "Discovery status unavailable",
      "Saved briefs may be out of date. Inspect the connection error below.",
      "settings",
    );
  if (!state)
    return result(
      "Checking discovery…",
      "Reading this Mac’s saved public briefs.",
    );
  if (!online)
    return result(
      "Peer networking is off",
      "Saved briefs remain searchable. Connect to receive updates.",
      "network",
    );
  if (!state.config.enabled)
    return result(
      "Discovery is off",
      "Choose how this Mac exchanges public mission briefs.",
      "settings",
    );
  if (!state.config.bootstrap.length && !state.health?.lan)
    return result(
      "No discovery sources",
      "Add a community peer or enable local network discovery. This is not an internet-wide mission directory.",
      "settings",
    );
  if (
    peers.length &&
    !recent &&
    peers.every((p) => !["waiting", "contacting", "ok"].includes(p.outcome))
  )
    return result(
      "No recent peer exchange",
      "Your discovery peers are not exchanging briefs. Inspect the connection details for the cause.",
      "settings",
    );
  if (!peers.length && state.health?.lan)
    return result(
      "Looking for nearby nodes",
      "LAN discovery reaches this local network. Add a community peer to reach other networks.",
      "settings",
    );
  if (!all.length)
    return result(
      recent ? "No public briefs received" : "Waiting for public briefs",
      recent
        ? "Peer exchange is working. Only missions whose owners publish a brief can appear."
        : peers.some((p) => p.last_success_ms)
          ? "Waiting for the next peer exchange. Connection details show the last successful contact."
          : "The first successful exchange has not been observed yet. Connection details show each attempt.",
    );
  if (!visible.length && search)
    return result(
      "No matching saved briefs",
      `No received mission matches “${query.trim()}”.`,
      "clear",
    );
  return result(
    `${all.length} saved public ${all.length === 1 ? "brief" : "briefs"}`,
    `${recent} ${recent === 1 ? "peer exchanged" : "peers exchanged"} briefs in the last 30 seconds. Search covers received briefs only.`,
  );
}
