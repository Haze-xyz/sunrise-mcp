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
