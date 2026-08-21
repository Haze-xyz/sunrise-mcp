// src/capabilities/register.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Capability, CapabilityContext } from './contract.js';

/**
 * Registers each capability as an MCP tool, forwarding calls to its run() with the shared ctx.
 * Typed on the concrete McpServer so the call site in index.ts needs no cast; the smoke passes a
 * structural fake at runtime (a .mjs, so it is not type-checked against McpServer).
 */
export function registerCapabilities(server: McpServer, ctx: CapabilityContext, caps: Capability[]): void {
  for (const cap of caps) {
    server.registerTool(
      cap.name,
      cap.config,
      async (args: Record<string, unknown>): Promise<CallToolResult> => cap.run(args, ctx),
    );
  }
}
