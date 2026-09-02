import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
const server = new McpServer({ name: "minimal", version: "1.0.0" });
server.registerTool("echo", { description: "echo", inputSchema: z.object({ text: z.string() }) }, async (i) => ({ content: [{ type: "text", text: i.text }] }));
serveStdio(() => server);
