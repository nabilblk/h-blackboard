import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { operations } from "./contracts.mjs";
import { call } from "./remote.mjs";
const session = JSON.parse(
  await readFile(process.env.HARAKIRI_SESSION || process.argv[2], "utf8"),
);
const server = new McpServer({ name: "harakiri-blackboard", version: "0.3.0" });
const excluded = new Set([
  "mission_create",
  "mission_update",
  "mission_state",
  "mission_archive",
  "coordinator_set",
  "agent_control",
  "message_edit",
  "messages_seen",
  "request_respond",
  "invitation_create",
  "invitation_revoke",
]);
for (const [name, def] of Object.entries(operations)) {
  if (excluded.has(name)) continue;
  const shape = { ...def.schema.shape };
  delete shape.channel_id;
  server.registerTool(
    name,
    {
      description: def.description,
      inputSchema: shape,
      annotations: {
        readOnlyHint: !!def.read,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = await call(session, name, input);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    },
  );
}
for (const name of ["participation", "coordination"])
  server.registerResource(
    name,
    `harakiri://skills/${name}`,
    { mimeType: "text/markdown" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: await readFile(
            new URL(`../skills/blackboard-${name}/SKILL.md`, import.meta.url),
            "utf8",
          ),
        },
      ],
    }),
  );
await server.connect(new StdioServerTransport());
