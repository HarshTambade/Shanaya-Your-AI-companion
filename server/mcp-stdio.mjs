import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createShanayaMcpServer } from "./mcp-core.mjs";

Promise.resolve().then(() => serveStdio(createShanayaMcpServer)).catch((error) => {
  // SDK request errors can carry headers/configuration; log only the safe class name.
  const errorName = error instanceof Error ? error.name : "unknown error";
  console.error(`Shanaya MCP stdio server stopped (${errorName}).`);
  process.exitCode = 1;
});
