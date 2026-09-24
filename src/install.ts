/**
 * Looking at an install and reporting what it is.
 *
 * Everything else in this server assumes an install: a game directory, a Sunrise DLL built from the
 * `mcp` branch, and an `mcp.json` beside Sunrise's settings that switches the console endpoint on.
 * When one of those assumptions is wrong, the
 * tool that trips over it reports a *game* failure -- a launch that did not happen, a refused
 * connection, a key to add by hand -- and the person reading it goes looking in the wrong place.
 * That is a measured defect, not a hypothetical one; it is what the first outside user reported.
 *
 * This module is the one place allowed to answer "what is this install", so every tool can quote it
 * instead of guessing. The verdict logic is in install-verdict.ts, with no I/O, so it is testable.
 */

import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  dllPath: string;
  mcpConfigPath: string;
  /** Sunrise's own settings file. Nothing of this layer lives in it; reported for its `version`. */
  settingsPath: string;
  facts: InstallFacts;
  verdict: InstallVerdict;
  /** What to tell a caller: what was found, what it means, what to do next. */
  message: string;
  /** Values worth reporting even when they do not change the verdict. */
  settings: {
    /** `version` in Sunrise's settings.json, when it could be read. */
    version: number | null;
    /** `core.logging.file_sink` in Sunrise's settings.json, when it could be read. */
    fileSink: boolean | null;
    endpointEnabled: boolean;
    endpointPort: number;
    /** What the values above do. See `describeBootSettings`. */
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

/** What this server reads out of Sunrise's own settings.json. Nothing of this layer lives there. */
export interface SettingsFindings {
  /** The `version` field. Upstream rewrites an older file with its bundled default. */
  version: number | null;
  /** `core.logging.file_sink`. Off means no sunrise.log, so log_read and wait_for see nothing. */
  fileSink: boolean | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads `version` and `core.logging.file_sink`, reporting `null` for anything it cannot read. */
export function readSettings(text: string): SettingsFindings {
  try {
    const parsed = asRecord(JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text));
    const logging = asRecord(asRecord(parsed?.['core'])?.['logging']);
    const version = parsed?.['version'];
    const fileSink = logging?.['file_sink'];
    return {
      version: typeof version === 'number' ? version : null,
      fileSink: typeof fileSink === 'boolean' ? fileSink : null,
    };
  } catch {
    return { version: null, fileSink: null };
  }
}

/** The endpoint port the DLL uses when mcp.json names none (`kDefaultEndpointPort`). */
export const DEFAULT_ENDPOINT_PORT = 30975;

export interface McpConfigFindings {
  /** False when the DLL would reject the document, which leaves its endpoint off. */
  valid: boolean;
  endpointEnabled: boolean;
  endpointPort: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads mcp.json exactly as the DLL does: a line-for-line port of the reader in
 * `src/mcp/settings/mcp_settings_parse.cpp` on the mcp branch, so the two cannot disagree. That is
 * why this is not `JSON.parse`, which accepts files the DLL rejects (`"port": 30975.0`, a `null`)
 * and rejects files the DLL accepts (`"port": 0080`). A leading BOM is fine, the top level must be
 * an object, unknown keys are skipped (nesting over 16 deep is refused), keys are compared as
 * written with escapes undecoded, `endpoint.enabled` must be `true`/`false` and `endpoint.port` a
 * plain integer from 1 to 65535. Anything else and the DLL keeps its defaults, endpoint off, so this
 * reports the endpoint off -- never "on" from a file the game ignored.
 */
export function readMcpConfig(text: string): McpConfigFindings {
  const rejected: McpConfigFindings = { valid: false, endpointEnabled: false, endpointPort: DEFAULT_ENDPOINT_PORT };
  const doc = text.startsWith('\uFEFF') ? text.slice(1) : text;
  let at = 0;
  const out = { enabled: false, port: DEFAULT_ENDPOINT_PORT };
  const take = (c: string): boolean => (doc[at] === c ? (at++, true) : false);
  const space = (): void => {
    while (at < doc.length && ' \t\r\n'.includes(doc[at] as string)) at++;
  };
  const literal = (word: string): boolean => (doc.startsWith(word, at) ? ((at += word.length), true) : false);
  const str = (): string | null => {
    if (!take('"')) return null;
    const start = at;
    while (at < doc.length) {
      const c = doc[at] as string;
      if (c === '"') return doc.slice(start, at++);
      if (c.charCodeAt(0) < 0x20) return null;
      at += c === '\\' ? 2 : 1;
    }
    return null;
  };
  const bool = (): boolean | null => (literal('true') ? true : literal('false') ? false : null);
  const integer = (): number | null => {
    const negative = take('-');
    const start = at;
    let value = 0;
    while (at < doc.length && (doc[at] as string) >= '0' && (doc[at] as string) <= '9') {
      if (value > 1_000_000) return null;
      value = value * 10 + (doc.charCodeAt(at) - 48);
      at++;
    }
    if (at === start || doc[at] === '.' || doc[at] === 'e' || doc[at] === 'E') return null;
    return negative ? -value : value;
  };
  const number = (): boolean => {
    take('-');
    const start = at;
    while (at < doc.length && '0123456789.eE+-'.includes(doc[at] as string)) at++;
    return at !== start;
  };
  const object = (member: (key: string) => boolean): boolean => {
    if (!take('{')) return false;
    space();
    if (take('}')) return true;
    for (;;) {
      space();
      const key = str();
      if (key === null) return false;
      space();
      if (!take(':')) return false;
      space();
      if (!member(key)) return false;
      space();
      if (take('}')) return true;
      if (!take(',')) return false;
    }
  };
  const skip = (depth: number): boolean => {
    if (depth > 16 || at >= doc.length) return false;
    const c = doc[at];
    if (c === '{') return object(() => skip(depth + 1));
    if (c === '[') {
      at++;
      space();
      if (take(']')) return true;
      for (;;) {
        space();
        if (!skip(depth + 1)) return false;
        space();
        if (take(']')) return true;
        if (!take(',')) return false;
      }
    }
    if (c === '"') return str() !== null;
    if (c === 't' || c === 'f') return bool() !== null;
    if (literal('null')) return true;
    return number();
  };
  const endpoint = (): boolean =>
    object((key) => {
      if (key === 'enabled') {
        const value = bool();
        if (value === null) return false;
        out.enabled = value;
        return true;
      }
      if (key === 'port') {
        const value = integer();
        if (value === null || value < 1 || value > 65535) return false;
        out.port = value;
        return true;
      }
      return skip(2);
    });
  space();
  const ok = object((key) => (key === 'endpoint' ? endpoint() : skip(1)));
  space();
  if (!ok || at !== doc.length) return rejected;
  return { valid: true, endpointEnabled: out.enabled, endpointPort: out.port };
}

/**
 * Whether a DLL was built with the MCP layer, told by the stable id of the menu page the layer
 * registers (`mcp.console`, in `src/mcp/console/overlay/console_page.cpp`). Sunrise's settings no
 * longer carry any key of this layer, so the binary is the only place the answer is.
 */
export function dllHasMcpLayer(bytes: Buffer): boolean {
  return bytes.includes('mcp.console', 0, 'latin1');
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
  const dllPath = path.win32.join(gameDir, 'bin', 'x64', 'steam_api64.dll');
  const sunriseDir = path.win32.join(gameDir, 'bin', 'x64', 'Sunrise');
  const settingsPath = path.win32.join(sunriseDir, 'settings.json');
  const mcpConfigPath = path.win32.join(sunriseDir, 'mcp.json');

  const gameDirExists = await exists(gameDir);
  const exePresent = gameDirExists && (await exists(exePath));

  let dllPresent = false;
  let dllHasLayer: boolean | null = null;
  if (gameDirExists) {
    try {
      dllHasLayer = dllHasMcpLayer(await readFile(dllPath));
      dllPresent = true;
    } catch {
      dllPresent = await exists(dllPath);
    }
  }

  let mcpConfigPresent = false;
  let config: McpConfigFindings = { valid: false, endpointEnabled: false, endpointPort: DEFAULT_ENDPOINT_PORT };
  if (gameDirExists) {
    try {
      config = readMcpConfig(await readFile(mcpConfigPath, 'utf8'));
      mcpConfigPresent = true;
    } catch {
      mcpConfigPresent = await exists(mcpConfigPath);
    }
  }

  let sunriseSettings: SettingsFindings = { version: null, fileSink: null };
  try {
    sunriseSettings = readSettings(await readFile(settingsPath, 'utf8'));
  } catch {
    // Informational only: nothing this layer needs is in Sunrise's settings.
  }

  const facts: InstallFacts = {
    gameDirResolved: true,
    gameDirFromEnv: gameDirSource === 'env',
    gameDirExists,
    exePresent,
    dllPresent,
    dllHasMcpLayer: dllHasLayer,
    mcpConfigPresent,
    mcpConfigValid: config.valid,
    endpointEnabled: config.endpointEnabled,
    fileSink: sunriseSettings.fileSink,
  };
  const verdict = decideInstallVerdict(facts);

  return {
    gameDir,
    gameDirSource,
    exePath,
    dllPath,
    mcpConfigPath,
    settingsPath,
    facts,
    verdict,
    message: describeInstallVerdict(verdict, facts, { gameDir, dllPath, mcpConfigPath, settingsPath }),
    settings: {
      version: sunriseSettings.version,
      fileSink: sunriseSettings.fileSink,
      endpointEnabled: config.endpointEnabled,
      endpointPort: config.endpointPort,
      notes: describeBootSettings({
        endpointEnabled: config.endpointEnabled,
        endpointPort: config.endpointPort,
        fileSink: sunriseSettings.fileSink,
      }),
    },
  };
}

/** Where the untouched original of mcp.json is kept the first time this server changes it. */
export function mcpConfigBackupPath(configPath: string): string {
  return `${configPath}.sunrise-mcp-backup`;
}

export interface EndpointEnableResult {
  /** `written`: there was no file. `alreadyOn`: nothing to do. `turnedOn`: a valid file had the
   *  endpoint off. `replaced`: the DLL would have rejected the file, so it was set aside. */
  status: 'written' | 'alreadyOn' | 'turnedOn' | 'replaced';
  path: string;
  backupPath?: string;
  message: string;
}

/**
 * Makes sure mcp.json switches the console endpoint on, which every tool here needs.
 *
 * It is this layer's own file, and the only one game_enter writes. A file that already enables the
 * endpoint is not touched at all. One that turns it off keeps every other key; one the DLL would
 * reject is replaced. Either way the text found first is copied aside once, never overwritten by a
 * later change, and the write is a rename so a crash cannot leave half a file.
 */
export async function ensureEndpointEnabled(configPath: string): Promise<EndpointEnableResult> {
  let text: string | null = null;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (err) {
    // Only a missing file is "no file". Anything else (no permission, a lock) is a file this call
    // cannot copy aside, so it must not be replaced either.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    text = null;
  }
  let next: Record<string, unknown> = { endpoint: { enabled: true } };
  let status: EndpointEnableResult['status'] = 'written';
  let dllAccepted = false;
  if (text !== null) {
    const config = readMcpConfig(text);
    if (config.valid && config.endpointEnabled) {
      return { status: 'alreadyOn', path: configPath, message: `${configPath} already switches the endpoint on.` };
    }
    let parsed: Record<string, unknown> | null = null;
    dllAccepted = config.valid;
    if (config.valid) {
      try {
        parsed = asRecord(JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text));
      } catch {
        // Valid for the DLL but not for JSON.parse (a "port": 0080): the keys cannot be carried
        // over safely, so the file is replaced and the original kept aside like any other.
        parsed = null;
      }
    }
    if (parsed !== null) {
      next = { ...parsed, endpoint: { ...(asRecord(parsed['endpoint']) ?? {}), enabled: true } };
      status = 'turnedOn';
    } else {
      status = 'replaced';
    }
    const backupPath = mcpConfigBackupPath(configPath);
    if (!(await exists(backupPath))) await copyFile(configPath, backupPath);
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(next)}\n`, 'utf8');
  await rename(tmpPath, configPath);
  const backupPath = text === null ? undefined : mcpConfigBackupPath(configPath);
  const what =
    status === 'written'
      ? 'did not exist, so it was written'
      : status === 'turnedOn'
        ? 'switched the endpoint off, so "endpoint"."enabled" was set to true and every other key kept'
        : dllAccepted
          ? 'switched the endpoint off in a form JSON cannot parse, so its keys could not be carried over and it was replaced'
          : 'was a file the DLL rejects, so it was replaced';
  return {
    status,
    path: configPath,
    ...(backupPath !== undefined ? { backupPath } : {}),
    message:
      `${configPath} ${what}. The console endpoint this server talks to is off unless that file turns it on, ` +
      'and the DLL reads it once at startup.' +
      (backupPath !== undefined ? ` The text found first is at ${backupPath}.` : ''),
  };
}
