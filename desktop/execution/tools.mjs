import { zodToJsonSchema } from "zod-to-json-schema";
import { AgentOperation } from "../node-service.mjs";

const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
const paths = { type: "array", items: string, minItems: 1, maxItems: 32 };
export function guestTools() {
  return [
    {
      name: "board",
      description:
        "Read or update your mission as your bound Agent/Coordinator. Begin with operation {type:'context'}. All authority is checked by the board. Control, direction and artifact IDs must come from actual board records.",
      inputSchema: object({
        operation: zodToJsonSchema(AgentOperation, { $refStrategy: "none" }),
      }),
    },
    {
      name: "workspace_exec",
      description:
        "Run a shell command in /workspace. Linux filesystem jail, no network, no credentials, no host mounts. Python 3 and standard Linux utilities are available. Maximum 60 seconds; background processes are killed when this call ends.",
      inputSchema: object({ command: { type: "string", maxLength: 16384 } }),
    },
    {
      name: "workspace_read",
      description:
        "Read a UTF-8 file, up to 512 KiB. Relative workspace path; no links or traversal.",
      inputSchema: object({ path: string }),
    },
    {
      name: "workspace_write",
      description:
        "Write a UTF-8 file in the isolated workspace. Parents are created; writes replace a file atomically.",
      inputSchema: object({ path: string, text: string }),
    },
    {
      name: "publish_artifact",
      description:
        "Publish exact workspace files as an immutable mission artifact. Use artifact:null and parents:[] for a new identity; use the existing artifact ID and exact parent revision(s) for updates. Inputs cite exact artifacts. Entrypoint is an HTML or text file among paths. Publication is separate from verification and human acceptance.",
      inputSchema: object({
        control: string,
        conversation: string,
        artifact: { type: ["string", "null"] },
        parents: { type: "array", items: string, maxItems: 256 },
        paths,
        document: object({
          title: string,
          summary: string,
          kind: {
            enum: ["plan", "report", "application", "data", "code", "document"],
          },
          stage: { enum: ["draft", "complete"] },
          limitations: string,
          entrypoint: { type: ["string", "null"] },
          inputs: { type: "array", items: string, maxItems: 16 },
        }),
      }),
    },
  ];
}
