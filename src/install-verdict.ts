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

/** What the settings file says about the fork's own keys. Absent keys are how you tell builds apart. */
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
  /** Whether the settings file the DLL reads exists. */
  settingsPresent: boolean;
  /** Whether anything at all could be read out of it. False means unreadable or unparseable. */
  settingsUnderstood: boolean;
  /** The `version` field, when there was one. Upstream's bundled default was 6, then 8. */
  settingsVersion: number | null;
  /** Whether `server.console_endpoint` exists. It is the fork's key: no upstream build has it. */
  hasConsoleEndpoint: boolean;
  /** Whether `client.hold_character_select` exists. Also the fork's. */
  hasHoldCharacterSelect: boolean;
  /** `server.console_endpoint.enabled`, when the key is there. */
  endpointEnabled: boolean | null;
}

export type InstallVerdict =
  /** Everything this server needs is present and switched on. */
  | 'ok'
  /** No game directory, or one that is not a game install. */
  | 'gameDirNotFound'
  /** The game is there but the settings file the DLL reads is not. */
  | 'settingsMissing'
  /** The settings file exists and nothing could be read out of it. */
  | 'settingsUnreadable'
  /** A real install, but not built from the fork: the keys this server drives do not exist in it. */
  | 'notForkBuild'
  /** The fork's build, with the console endpoint switched off -- which is every tool here failing
   *  with a refused connection and nothing saying why. It ships off by default. */
  | 'endpointDisabled';

/**
 * Names what an install is.
 *
 * The order matters, and it is the order a person would check in: is the game there, is its
 * configuration there, can it be read, is it the right build, is the thing switched on. Each answer
 * makes the next question meaningful, and reporting a later problem before an earlier one is how a
 * message ends up describing a symptom instead of a cause.
 *
 * `notForkBuild` is decided on *both* fork keys being absent rather than either one, deliberately.
 * A single missing key is a settings file someone edited; both missing is a different build. Saying
 * "this is not the fork" to someone who deleted one line would be a worse error than the one this
 * replaces.
 */
export function decideInstallVerdict(facts: InstallFacts): InstallVerdict {
  if (!facts.gameDirResolved || !facts.gameDirExists || !facts.exePresent) return 'gameDirNotFound';
  if (!facts.settingsPresent) return 'settingsMissing';
  if (!facts.settingsUnderstood) return 'settingsUnreadable';
  if (!facts.hasConsoleEndpoint && !facts.hasHoldCharacterSelect) return 'notForkBuild';
  if (facts.endpointEnabled === false) return 'endpointDisabled';
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
  settingsPath: string | null;
}): string {
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
    case 'settingsMissing':
      return (
        `The game is at ${paths.gameDir}, but ${paths.settingsPath} does not exist. That is the ` +
        'file the Sunrise DLL reads -- not bin\\x64\\settings.json, which nothing reads. Launch the ' +
        'game once to have it written, or copy the fork\'s resources/default_settings.json there.'
      );
    case 'settingsUnreadable':
      return (
        `${paths.settingsPath} exists but nothing could be read out of it, so this server cannot ` +
        'tell which build it is talking to. It is JSON; check it parses.'
      );
    case 'notForkBuild':
      return (
        `${paths.settingsPath} carries neither "console_endpoint" nor "hold_character_select". ` +
        'Both are additions of the private Sunrise fork this server pairs with, so this install was ' +
        'built from upstream Sunrise (or another fork), and none of the things this server drives ' +
        'exist in it -- there is no console endpoint to connect to, and no mem.* or character.* ' +
        'behind it. This is a build problem, not a game problem: deploy a steam_api64.dll built ' +
        'from the fork. See the README.'
      );
    case 'endpointDisabled':
      return (
        `This is the fork's build, and "console_endpoint" is present in ${paths.settingsPath} with ` +
        '"enabled": false -- which is what the fork ships by default. While it is off, the listener ' +
        'is never created, so every tool here fails with a refused connection and nothing in the ' +
        'game is wrong. Set "enabled": true under "server" > "console_endpoint" and restart the game.'
      );
    case 'ok': {
      const version = facts.settingsVersion === null ? 'no version field' : `settings version ${facts.settingsVersion}`;
      return `Install looks right: ${paths.gameDir}, the fork's keys are present, the console endpoint is on (${version}).`;
    }
  }
}

/** The settings values a report carries beyond the verdict. `null` is "not read", never "false". */
export interface BootSettingsFacts {
  /** `server.console_endpoint.enabled`. */
  endpointEnabled: boolean | null;
  /** `server.console_endpoint.port`. */
  endpointPort: number | null;
  /** `client.hold_character_select`. */
  holdCharacterSelect: boolean | null;
}

/**
 * Says what the boot settings in hand actually do, one line each.
 *
 * It exists because of the second piece of outside feedback this server got: *"one thing that is not
 * clear to my agent are boot settings"*. The settings block of a report is bare values --
 * `holdCharacterSelect: true` -- and an agent reading that has nothing to decide with: it cannot
 * tell that the flag is the difference between a launch that parks on a screen forever and one that
 * enters by itself, nor that the second costs it the player object. So each value gets a sentence
 * about the value that is there, not a manual for the key.
 *
 * Both keys are read once, at startup, by code the console cannot reach -- the hold hook installs in
 * `bootflow_hook_lifecycle.cpp::install()` and the listener is created in `server_runtime.cpp` --
 * which is why the header line says a change needs a restart rather than a command.
 *
 * @param settings The values install.ts read, with `null` for anything it could not read.
 * @returns One header line plus one line per setting, in the order a caller meets them.
 */
export function describeBootSettings(settings: BootSettingsFacts): string[] {
  const notes: string[] = [
    'Boot settings: both are read once at startup by code the console cannot reach, so changing ' +
      'either needs the game restarted (game_kill, then game_enter). No console command moves them.',
  ];

  if (settings.endpointEnabled === true) {
    notes.push(
      '"server.console_endpoint": enabled, ' +
        (settings.endpointPort === null ? 'port not read' : `port ${settings.endpointPort}`) +
        ' -- the socket console_run, console_describe and every mem.* and character.* tool talk to. ' +
        'It serves one client at a time, and a client holds it for the life of its process, so a ' +
        'second MCP server pointed at this game is refused rather than queued.',
    );
  } else if (settings.endpointEnabled === false) {
    notes.push(
      '"server.console_endpoint": { "enabled": false } -- the listener is never created, so every ' +
        'tool that talks to the game fails with a refused connection and nothing in the game is wrong.',
    );
  } else {
    notes.push(
      '"server.console_endpoint": not read, so whether anything can connect is unknown. That is a ' +
        'settings file this server could not parse, not a report that the endpoint is off.',
    );
  }

  if (settings.holdCharacterSelect === true) {
    notes.push(
      '"client.hold_character_select": true -- the client stops at the character-select screen and ' +
        'waits for a pick, so a launch with nobody choosing parks there for good. It is also the ' +
        'state a session meant to be played wants: the client\'s own character-select step, actually ' +
        'run, is what creates the player object (measured 2026-08-19 -- picked by hand, the ship is ' +
        'in orbit and a destination spawns normally). game_enter { character } rewrites this key to ' +
        'false before it launches, copies the untouched original aside the first time it ever does so, ' +
        'and reports the change in its response.',
    );
  } else if (settings.holdCharacterSelect === false) {
    notes.push(
      '"client.hold_character_select": false -- there is no character screen: the sign-in step ' +
        'selects on its own, which is what lets game_enter { character } reach the world with no ' +
        'hands. What it costs, measured 2026-08-19 and 2026-08-21: the client arrives in orbit with ' +
        'no player object -- no ship, player.position present:false -- and a destination launched ' +
        'from there loads correctly, with nobody in it: a black screen and no error anywhere. So if ' +
        'what you are testing is a destination, this value is the one that guarantees you cannot ' +
        'see it, and it will not look like a failure. Nothing restores the key: set it back to true, ' +
        'restart, and make the pick on the real screen (game_enter with no character stops there, ' +
        'and input.hold drives that screen) before going anywhere.',
    );
  } else {
    notes.push(
      '"client.hold_character_select": not read. The game\'s own default is true ' +
        '(core/settings/client/definition.h), which is the parks-on-the-screen behaviour. ' +
        'game_enter { character } refuses rather than adding an absent key, so add it under ' +
        '"client" by hand if a hands-free entry is what you want.',
    );
  }

  return notes;
}
