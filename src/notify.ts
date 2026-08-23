/**
 * Sending one line to a human, over Telegram, from an unattended job.
 *
 * Deliberately optional: with no bot token and no chat id in the environment, this reports that it
 * did not send and why, and the caller carries on. A sync that refuses to run because nobody is
 * listening would be worse than a sync nobody hears about -- the fork still gets updated, and the
 * same conclusion is on stdout either way.
 *
 * Nothing here is Sunrise-specific; it takes a string.
 */

/** Where the credentials come from. Both must be present for anything to be sent. */
const TOKEN_VAR = 'TELEGRAM_BOT_TOKEN';
const CHAT_VAR = 'TELEGRAM_CHAT_ID';

/** Telegram rejects a message body over 4096 characters, so a long conflict list is cut, visibly. */
const MAX_BODY = 4096;
const TRUNCATION_NOTE = '\n[...] truncated';

export interface NotifyResult {
  /** True only when Telegram accepted the message. */
  sent: boolean;
  /** Why it was not sent, when it was not. Present exactly when `sent` is false. */
  reason?: string;
}

/** Cuts to Telegram's limit, saying so in the text rather than silently dropping the tail. */
export function clampBody(text: string): string {
  if (text.length <= MAX_BODY) return text;
  return text.slice(0, MAX_BODY - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
}

/**
 * Sends one message, if the environment carries both credentials.
 *
 * @param text What to send. Plain text; no parse mode is requested, so nothing in it is markup and
 *             a stray underscore in a file path cannot make Telegram reject the whole message.
 * @param env  Overridable for tests. Defaults to the real process environment.
 * @returns Whether it was sent, and why not when it was not. Never throws: a notifier that can take
 *          down the job it reports on is a worse notifier than one that stays quiet.
 */
export async function notifyTelegram(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NotifyResult> {
  const token = env[TOKEN_VAR];
  const chatId = env[CHAT_VAR];
  if (!token || !chatId) {
    const missing = [!token ? TOKEN_VAR : null, !chatId ? CHAT_VAR : null].filter(Boolean);
    return { sent: false, reason: `${missing.join(' and ')} not set, so nothing was sent.` };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: clampBody(text), disable_web_page_preview: true }),
    });
    if (!response.ok) {
      // Telegram puts the real reason in the body, and it is the only useful part of a 400.
      const detail = await response.text().catch(() => '');
      return { sent: false, reason: `Telegram answered ${response.status}: ${detail.slice(0, 300)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
