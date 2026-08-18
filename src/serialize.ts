/**
 * A one-at-a-time queue for tool calls that must not overlap.
 *
 * `game_enter` is the reason this exists. Every guard it has against a spurious keystroke is a
 * read-then-act sequence — observe that Enter has not already been pressed for this pid, then press
 * and record it — and none of those steps is atomic across the awaits between them. Two calls
 * arriving together would both make the observation before either wrote the record, and both would
 * fire `SendInput` into the game: exactly the defect four review rounds closed on every other path,
 * reached instead through the one door none of them shut. Nothing in the MCP protocol stops a
 * client dispatching tool calls concurrently, so the safety claim was resting on client behaviour
 * this repo does not control.
 *
 * Serializing the whole call, rather than locking around the record, is deliberate: the press also
 * takes the OS foreground, minimizes and restores a window, and settles for over a second. Two of
 * those interleaved would fight each other even if the record were perfectly guarded.
 *
 * Scope is one process, which is the same scope as the in-process press cache it protects. The
 * durable record is what covers the restart case, and it already does.
 */

/** Runs one call, given nothing. */
export type SerializedCall<T> = () => Promise<T>;

/**
 * Builds a queue that runs one call at a time, in arrival order.
 *
 * A rejected call must not poison the queue for the next one, so the tail this keeps is the
 * settled form of each call rather than the call itself; the caller still receives its own
 * rejection unchanged.
 *
 * @returns A function that enqueues one call and resolves to its result.
 */
export function createSerializer(): <T>(run: SerializedCall<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(run: SerializedCall<T>): Promise<T> => {
    // `then(run, run)` rather than `then(run)`: the tail below can never reject, but writing the
    // rejection handler in makes the queue correct even if that ever changes.
    const result = tail.then(run, run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
