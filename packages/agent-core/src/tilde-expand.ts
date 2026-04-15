import os from "node:os";

import { createMiddleware } from "langchain";

import { createLogger } from "./logger.js";

const log = createLogger("tilde");

/**
 * Middleware that expands `~` in filesystem tool path arguments to the actual
 * home directory. deepagentsjs does NOT expand `~` in any mode — neither
 * virtualMode=true nor virtualMode=false — so tools like `ls ~/Desktop` would
 * look for a literal `~` directory instead of the user's home.
 *
 * This middleware intercepts tool calls for known filesystem tools and rewrites
 * path-like arguments before they reach the backend.
 */

const FS_TOOLS = new Set(["ls", "read_file", "write_file", "edit_file", "glob", "grep"]);
const PATH_ARGS = new Set(["path", "file_path", "directory"]);

function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return os.homedir() + value.slice(1);
  return value;
}

export function createTildeExpandMiddleware() {
  return createMiddleware({
    name: "tildeExpandMiddleware",
    wrapToolCall: async (request, handler) => {
      const toolName = request.toolCall?.name;
      if (!toolName || !FS_TOOLS.has(toolName)) {
        return handler(request);
      }

      const args = request.toolCall.args;
      if (!args || typeof args !== "object") {
        return handler(request);
      }

      let modified = false;
      const newArgs = { ...args };

      for (const key of Object.keys(newArgs)) {
        if (PATH_ARGS.has(key) && typeof newArgs[key] === "string") {
          const expanded = expandTilde(newArgs[key] as string);
          if (expanded !== newArgs[key]) {
            newArgs[key] = expanded;
            modified = true;
          }
        }
      }

      if (modified) {
        log.debug("expanded", { tool: toolName, args: newArgs });
        return handler({
          ...request,
          toolCall: {
            ...request.toolCall,
            args: newArgs,
          },
        });
      }

      return handler(request);
    },
  });
}
