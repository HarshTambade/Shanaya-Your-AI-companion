import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createShanayaMcpServer } from "./mcp-core.mjs";

function matchesBearerToken(header, expectedToken) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(header || "");
  if (!match) return false;
  const candidate = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function mountShanayaMcpEndpoint(app, token) {
  if (typeof token !== "string" || token.length < 32) {
    throw new Error("Set MCP_API_TOKEN to a random value of at least 32 characters before enabling the remote MCP endpoint.");
  }

  const handler = createMcpHandler(() => createShanayaMcpServer());
  const nodeHandler = toNodeHandler(handler);

  app.all("/mcp", (req, res, next) => {
    if (!matchesBearerToken(req.get("authorization"), token)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ error: "A valid Shanaya MCP bearer token is required." });
    }

    res.setHeader("Cache-Control", "no-store");
    void nodeHandler(req, res, req.body).catch((error) => {
      if (res.headersSent) return res.destroy(error);
      next(error);
    });
  });
}
