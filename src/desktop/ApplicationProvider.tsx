import { createContext, useContext, type ReactNode } from "react";
import type { BlackboardClient } from "../application/client";

const ApplicationContext = createContext<BlackboardClient | null>(null);

/** Pass one stable client per workspace. An alternative shell supplies its own
 * adapter; presentational components in src/ui never consume this context. */
export function ApplicationProvider({
  client,
  children,
}: {
  client: BlackboardClient;
  children: ReactNode;
}) {
  return (
    <ApplicationContext.Provider value={client}>
      {children}
    </ApplicationContext.Provider>
  );
}

export function useApplication(): BlackboardClient {
  const client = useContext(ApplicationContext);
  if (!client)
    throw new Error("Blackboard UI requires an ApplicationProvider.");
  return client;
}
