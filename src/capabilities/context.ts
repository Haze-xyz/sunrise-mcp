// src/capabilities/context.ts
import type { CapabilityContext, SunriseConsole } from './contract.js';
import { createMemFacade } from './mem.js';
import type { SunriseEndpointClient } from '../endpoint.js';
import { launchGame, killGame, readLog, getLogPath, getExePath, getSettingsPath } from '../game.js';
import { getGameProcessInfo } from '../tasklist.js';

/** Assembles the real capability context: console + mem + game helpers + stderr log. */
export function buildContext(endpoint: SunriseEndpointClient): CapabilityContext {
  const sunriseConsole: SunriseConsole = {
    runLine: (line) => endpoint.runLine(line),
    describe: () => endpoint.describe(),
  };
  return {
    console: sunriseConsole,
    mem: createMemFacade(sunriseConsole),
    game: {
      launch: launchGame,
      kill: killGame,
      readLog,
      processInfo: getGameProcessInfo,
      paths: { log: getLogPath, exe: getExePath, settings: getSettingsPath },
    },
    // stdout is the MCP wire; diagnostics go to stderr, matching index.ts.
    log: (message: string) => console.error(`[sunrise-mcp] ${message}`),
  };
}
