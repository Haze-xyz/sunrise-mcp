/**
 * Looking at an install and reporting what it is.
 *
 * Everything else in this server assumes an install: a game directory, a settings file at one exact
 * path, and keys in it that only the fork's DLL has. When one of those assumptions is wrong, the
 * tool that trips over it reports a *game* failure -- a launch that did not happen, a refused
 * connection, a key to add by hand -- and the person reading it goes looking in the wrong place.
 * That is a measured defect, not a hypothetical one; it is what the first outside user reported.
 *
 * This module is the one place allowed to answer "what is this install", so every tool can quote it
 * instead of guessing. The verdict logic is in install-verdict.ts, with no I/O, so it is testable.
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  decideInstallVerdict,
  describeBootSettings,
  describeInstallVerdict,
  type InstallFacts,
  type InstallVerdict,
} from './install-verdict.js';

/**
 * The path this server used to reach for silently. It is kept as a *fallback* rather than deleted,
 * because it is right on the machine this was written on and removing it would break that setup for
 * no gain -- but every report says out loud when it was used, which is what was missing.
 */
const FALLBACK_GAME_DIR = 'E:\\Destiny_Sunrise';
const GAME_DIR_VAR = 'SUNRISE_GAME_DIR';

export interface InstallReport {
  gameDir: string;
  /** `env` when SUNRISE_GAME_DIR named it, `fallback` when this server chose it. */
  gameDirSource: 'env' | 'fallback';
  exePath: string;
  settingsPath: string;
  facts: InstallFacts;
  verdict: InstallVerdict;
  /** What to tell a caller: what was found, what it means, what to do next. */
  message: string;
  /** Values worth reporting even when they do not change the verdict. */
  settings: {
    version: number | null;
    endpointEnabled: boolean | null;
    endpointPort: number | null;
    holdCharacterSelect: boolean | null;
    /** What the two boot settings above do, given the values that are there. See
     *  `describeBootSettings`: the values alone told a reader nothing about what to do next. */
    notes: string[];
  };
}

/** Where the game directory comes from, and whether anyone said so. */
export function resolveGameDirWithSource(env: NodeJS.ProcessEnv = process.env): {
  dir: string;
  source: 'env' | 'fallback';
} {
  const fromEnv = env[GAME_DIR_VAR];
  if (fromEnv && fromEnv.length > 0) return { dir: fromEnv, source: 'env' };
  return { dir: FALLBACK_GAME_DIR, source: 'fallback' };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

interface SettingsFindings {
  understood: boolean;
  version: number | null;
  hasConsoleEndpoint: boolean;
  hasHoldCharacterSelect: boolean;
  endpointEnabled: boolean | null;
  endpointPort: number | null;
  holdCharacterSelect: boolean | null;
}

const NOT_UNDERSTOOD: SettingsFindings = {
  understood: false,
  version: null,
  hasConsoleEndpoint: false,
  hasHoldCharacterSelect: false,
  endpointEnabled: null,
  endpointPort: null,
  holdCharacterSelect: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads what matters out of a settings document.
 *
 * Parses it as JSON first, because that is what the file is and what the game's own parser accepts.
 * When that fails, falls back to naming the keys by pattern rather than reporting nothing: a file
 * this server cannot parse may still be a file whose *shape* answers "is this the fork's build",
 * and that question is worth answering even from a document with a stray comma in it. Which path
 * was taken is not hidden -- a probe-only read cannot see `enabled`, and reports it as unknown
 * rather than as false.
 */
export function readSettings(text: string): SettingsFindings {
  try {
    const parsed = asRecord(JSON.parse(text));
    if (parsed) {
      const server = asRecord(parsed['server']);
      const client = asRecord(parsed['client']);
      const endpoint = server ? asRecord(server['console_endpoint']) : null;
      const version = parsed['version'];
      const hold = client ? client['hold_character_select'] : undefined;
      return {
        understood: true,
        version: typeof version === 'number' ? version : null,
        hasConsoleEndpoint: server !== null && 'console_endpoint' in server,
        hasHoldCharacterSelect: client !== null && 'hold_character_select' in client,
        endpointEnabled: endpoint && typeof endpoint['enabled'] === 'boolean' ? endpoint['enabled'] : null,
        endpointPort: endpoint && typeof endpoint['port'] === 'number' ? endpoint['port'] : null,
        holdCharacterSelect: typeof hold === 'boolean' ? hold : null,
      };
    }
  } catch {
    // Not JSON this server can parse. The shape probes below still answer the build question.
  }

  const versionMatch = /"version"\s*:\s*(\d+)/.exec(text);
  const holdMatch = /"hold_character_select"\s*:\s*(true|false)/.exec(text);
  const hasConsoleEndpoint = /"console_endpoint"\s*:/.test(text);
  const hasHold = /"hold_character_select"\s*:/.test(text);
  return {
    understood: hasConsoleEndpoint || hasHold || versionMatch !== null,
    version: versionMatch?.[1] === undefined ? null : Number.parseInt(versionMatch[1], 10),
    hasConsoleEndpoint,
    hasHoldCharacterSelect: hasHold,
    // Deliberately unknown rather than false: a probe cannot see inside the object, and reporting
    // "disabled" for something it never read would send the reader to change a setting that is fine.
    endpointEnabled: null,
    endpointPort: null,
    holdCharacterSelect: holdMatch?.[1] === undefined ? null : holdMatch[1] === 'true',
  };
}

/**
 * Looks at the install this server is configured for, and says what it is.
 *
 * @param env Overridable for tests.
 * @returns A report that is always complete: every field is filled even when the verdict is a
 *          failure, because the fields are how a caller tells one failure from another.
 */
export async function inspectInstall(env: NodeJS.ProcessEnv = process.env): Promise<InstallReport> {
  const { dir: gameDir, source: gameDirSource } = resolveGameDirWithSource(env);
  const exePath = path.win32.join(gameDir, 'destiny2.exe');
  const settingsPath = path.win32.join(gameDir, 'bin', 'x64', 'Sunrise', 'settings.json');

  const gameDirExists = await exists(gameDir);
  const exePresent = gameDirExists && (await exists(exePath));

  let findings = NOT_UNDERSTOOD;
  let settingsPresent = false;
  if (gameDirExists) {
    try {
      const text = await readFile(settingsPath, 'utf8');
      settingsPresent = true;
      findings = readSettings(text);
    } catch {
      settingsPresent = await exists(settingsPath);
    }
  }

  const facts: InstallFacts = {
    gameDirResolved: true,
    gameDirFromEnv: gameDirSource === 'env',
    gameDirExists,
    exePresent,
    settingsPresent,
    settingsUnderstood: findings.understood,
    settingsVersion: findings.version,
    hasConsoleEndpoint: findings.hasConsoleEndpoint,
    hasHoldCharacterSelect: findings.hasHoldCharacterSelect,
    endpointEnabled: findings.endpointEnabled,
  };
  const verdict = decideInstallVerdict(facts);

  return {
    gameDir,
    gameDirSource,
    exePath,
    settingsPath,
    facts,
    verdict,
    message: describeInstallVerdict(verdict, facts, { gameDir, settingsPath }),
    settings: {
      version: findings.version,
      endpointEnabled: findings.endpointEnabled,
      endpointPort: findings.endpointPort,
      holdCharacterSelect: findings.holdCharacterSelect,
      notes: describeBootSettings(findings),
    },
  };
}
