// src/capabilities/register.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Capability, CapabilityContext } from './contract.js';

/**
 * Registers each capability as an MCP tool, forwarding calls to its run() with the shared ctx.
 * Typed on the concrete McpServer so the call site in index.ts needs no cast; the smoke passes a
 * structural fake at runtime (a .mjs, so it is not type-checked against McpServer).
 *
 * `wrap` is index.ts's withEndurance, passed in rather than imported here so this module stays free
 * of the journal/supervisor machinery -- struct_read gets the same journal entry and liveness
 * preflight as the other game-facing tools, applied the same way, by name.
 */
export function registerCapabilities(
  server: McpServer,
  ctx: CapabilityContext,
  caps: Capability[],
  wrap: (name: string, handler: (args: Record<string, unknown>) => Promise<CallToolResult>) => (args: Record<string, unknown>) => Promise<CallToolResult>,
): void {
  for (const cap of caps) {
    server.registerTool(cap.name, cap.config, wrap(cap.name, async (args) => cap.run(args, ctx)));
  }
}
