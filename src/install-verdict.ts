/**
 * What an install *is*, decided from facts about it and nothing else -- no filesystem, no game.
 * install.ts gathers the facts; this file says what they mean and what a caller should be told.
 *
 * It exists because of one sentence of feedback from the first person other than the author to run
 * this server: *"the main friction was its hardcoded Sunrise directory and poor handling of newer
 * settings/cache files, which caused a misleading game error."* Every failure it names here used to
 * surface as something about the game -- a launch that did not happen, a connection that was
 * refused, a key to add by hand -- when the real answer was always about configuration.
 */

/** What an install holds, as far as this server can tell from files. */
export interface InstallFacts {
  /** Whether a game directory was resolved at all. */
  gameDirResolved: boolean;
  /** Whether it came from SUNRISE_GAME_DIR rather than from this server's fallback. The difference
   *  is the whole point of the message when the directory turns out not to exist: one is "your
   *  setting is wrong", the other is "you have no setting and mine is not your machine". */
  gameDirFromEnv: boolean;
  /** Whether that directory exists on disk. */
  gameDirExists: boolean;
  /** Whether `destiny2.exe` is in it. A directory without it is not a game install. */
  exePresent: boolean;
  /** Whether `bin\x64\steam_api64.dll` exists. Without it there is no Sunrise at all. */
  dllPresent: boolean;
  /** Whether that DLL carries the MCP layer. `null` when it could not be read: unknown, not no. */
  dllHasMcpLayer: boolean | null;
  /** Whether `mcp.json` exists beside Sunrise's settings. */
  mcpConfigPresent: boolean;
  /** Whether the DLL would accept it. A rejected file leaves the defaults: endpoint off. */
  mcpConfigValid: boolean;
  /** Whether the endpoint is on, as the DLL will read it. */
  endpointEnabled: boolean;
}

export type InstallVerdict =
  /** Everything this server needs is present and switched on. */
  | 'ok'
  /** No game directory, or one that is not a game install. */
  | 'gameDirNotFound'
  /** No Sunrise DLL, or one built without the MCP layer: there is no console endpoint to reach. */
  | 'notMcpBuild'
  /** The layer is there, but no mcp.json switches its endpoint on. */
  | 'mcpConfigMissing'
  /** mcp.json exists and the DLL would reject it, which leaves the endpoint off. */
  | 'mcpConfigInvalid'
  /** mcp.json is valid and leaves the endpoint off. */
  | 'endpointDisabled';

/**
 * Names what an install is.
 *
 * The order matters, and it is the order a person would check in: is the game there, is it the
 * right build, is the switch file there, can it be read, is the thing switched on. Each answer makes
 * the next question meaningful, and reporting a later problem before an earlier one is how a message
 * ends up describing a symptom instead of a cause.
 *
 * A DLL that could not be read is not called the wrong build: that would send the reader to rebuild
 * something that may be fine.
 */
export function decideInstallVerdict(facts: InstallFacts): InstallVerdict {
  if (!facts.gameDirResolved || !facts.gameDirExists || !facts.exePresent) return 'gameDirNotFound';
  if (!facts.dllPresent || facts.dllHasMcpLayer === false) return 'notMcpBuild';
  if (!facts.mcpConfigPresent) return 'mcpConfigMissing';
  if (!facts.mcpConfigValid) return 'mcpConfigInvalid';
  if (!facts.endpointEnabled) return 'endpointDisabled';
  return 'ok';
}

/** Whether this install can be expected to answer on the console endpoint at all. */
export function canServe(verdict: InstallVerdict): boolean {
  return verdict === 'ok';
}

/**
 * What to tell a caller, in one paragraph: what was found, what it means, and the single next thing
 * to do about it. Written for an agent holding these tools and no filesystem, which is why every
 * message names a file and a key rather than saying "check your configuration".
 */
export function describeInstallVerdict(verdict: InstallVerdict, facts: InstallFacts, paths: {
  gameDir: string | null;
  dllPath: string | null;
  mcpConfigPath: string | null;
}): string {
  const fix = `Write {"endpoint":{"enabled":true}} to ${paths.mcpConfigPath} and restart the game.`;
  switch (verdict) {
    case 'gameDirNotFound':
      if (!facts.gameDirResolved) {
        return (
          'No game directory is configured. Set SUNRISE_GAME_DIR to the folder holding ' +
          'destiny2.exe. Nothing was guessed: a built-in path belongs to whoever wrote it.'
        );
      }
      if (!facts.gameDirExists) {
        return facts.gameDirFromEnv
          ? `SUNRISE_GAME_DIR points at ${paths.gameDir}, which does not exist. Point it at the ` +
            'folder holding destiny2.exe.'
          : `SUNRISE_GAME_DIR is not set, so this fell back to ${paths.gameDir} -- the author's own ` +
            'path, which does not exist on this machine. Set SUNRISE_GAME_DIR to the folder holding ' +
            'destiny2.exe. Nothing else was guessed.';
      }
      return (
        `${paths.gameDir} exists but holds no destiny2.exe, so it is not a game install. ` +
        'Set SUNRISE_GAME_DIR to the folder that does.'
      );
    case 'notMcpBuild':
      return facts.dllPresent
        ? `${paths.dllPath} is a Sunrise build without the MCP layer (it registers no "mcp.console" ` +
            'page), so there is no console endpoint to connect to and no mem.* or character.* behind ' +
            'it. This is a build problem, not a game problem: build the mcp branch of ' +
            'Haze-xyz/Sunrise (fork_build) and deploy its steam_api64.dll (dll_deploy). See the README.'
        : `There is no ${paths.dllPath}, so Sunrise is not installed in this game directory. Build the ` +
            'mcp branch of Haze-xyz/Sunrise (fork_build) and deploy its steam_api64.dll (dll_deploy).';
    case 'mcpConfigMissing':
      return (
        `The DLL has the MCP layer, but ${paths.mcpConfigPath} does not exist, so its console endpoint ` +
        `is off (the layer never opens a port nobody asked for). ${fix} game_enter writes it for you.`
      );
    case 'mcpConfigInvalid':
      return (
        `${paths.mcpConfigPath} exists but the DLL rejects it -- it must be a JSON object, with ` +
        '"endpoint"."enabled" a boolean and "endpoint"."port" an integer from 1 to 65535 -- so the ' +
        `endpoint stays off. ${fix}`
      );
    case 'endpointDisabled':
      return (
        `${paths.mcpConfigPath} leaves the console endpoint off, so every tool here fails with a ` +
        `refused connection and nothing in the game is wrong. ${fix}`
      );
    case 'ok':
      return `Install looks right: ${paths.gameDir}, a DLL with the MCP layer, and the console endpoint on in ${paths.mcpConfigPath}.`;
  }
}

/** The mcp.json values a report carries beyond the verdict. */
export interface BootSettingsFacts {
  endpointEnabled: boolean;
  endpointPort: number;
  /** `core.logging.file_sink` in Sunrise's settings.json; `null` when it could not be read. */
  fileSink: boolean | null;
}

/**
 * Says what the boot settings in hand actually do, one line each.
 *
 * It exists because of a piece of outside feedback: *"one thing that is not clear to my agent are
 * boot settings"*. Bare values leave an agent nothing to decide with, so each value gets a sentence
 * about the value that is there, not a manual for the key.
 *
 * mcp.json is read once, when the layer initializes, which is why the header line says a change
 * needs a restart rather than a command.
 */
export function describeBootSettings(settings: BootSettingsFacts): string[] {
  const notes: string[] = [
    'Boot settings: mcp.json is read once at startup, so changing it needs the game restarted ' +
      '(game_kill, then game_enter). No console command moves it.',
  ];
  if (settings.endpointEnabled) {
    notes.push(
      `"endpoint": enabled, port ${settings.endpointPort} -- the socket console_run, console_describe ` +
        'and every mem.* and character.* tool talk to. It serves one client at a time, and a client ' +
        'holds it for the life of its process, so a second MCP server pointed at this game is ' +
        'refused rather than queued.',
    );
  } else {
    notes.push(
      '"endpoint": off -- the listener is never created, so every tool that talks to the game is ' +
        'refused a connection and nothing in the game is wrong.',
    );
  }
  if (settings.fileSink === false) {
    notes.push(
      '"core.logging.file_sink": false in Sunrise\'s settings.json -- the game writes no sunrise.log, so ' +
        'log_read, wait_for and game_enter see nothing and game_enter times out. Sunrise 0.5.1 ships it off ' +
        'and rewrites the file with that default whenever its version is older. Set it to true and restart.',
    );
  } else if (settings.fileSink === null) {
    notes.push(
      '"core.logging.file_sink": not read from Sunrise\'s settings.json. If it is false the game writes no ' +
        'sunrise.log, and log_read, wait_for and game_enter see nothing.',
    );
  }
  return notes;
}
