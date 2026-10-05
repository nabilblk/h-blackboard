// Routing is syntactic only. Cryptographic verification and live mission
// review still happen after the human explicitly enables the connection.
export function invitationLink(raw) {
  if (
    typeof raw !== "string" ||
    raw.length > 16384 ||
    !/^harakiri:\/\/join\/[a-f0-9]+$/.test(raw)
  )
    return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "harakiri:" ||
      url.hostname !== "join" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    return /^\/[a-f0-9]+$/.test(url.pathname) ? raw : null;
  } catch {
    return null;
  }
}
