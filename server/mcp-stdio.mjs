import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createShanayaMcpServer } from "./mcp-core.mjs";

try {
  serveStdio(createShanayaMcpServer);
} catch (error) {
  console.error("Shanaya MCP stdio server stopped:", error);
  process.exitCode = 1;
}
