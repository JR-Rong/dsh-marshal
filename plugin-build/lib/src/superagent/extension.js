/**
 * The board extension face.
 *
 * The task board tells providers when an execution settles; that is the only
 * board event this bridge needs. The extension writes its dispatch metadata into
 * the card's integrations payload so the card itself, the status tool and a
 * later human reader can see which agent ran and whether its memory write
 * landed.
 */

export const SUPERAGENT_EXTENSION_ID = 'marshal-superagent';

export function createBoardExtension({ dispatcher, logger = { warn: () => {} }, onStart, onStop }) {
    let host;
    let disposers = [];
    let settledCount = 0;
    let lastSettledAt;
    const handle = event => {
        settledCount += 1;
        lastSettledAt = Date.now();
        Promise.resolve(dispatcher.settle(event, host)).catch(cause => {
            logger.warn?.('marshal-superagent: settle failed: ' + (cause instanceof Error ? cause.message : String(cause)));
        });
    };
    return {
        id: SUPERAGENT_EXTENSION_ID,
        apiVersion: 1,
        start(next) {
            host = next;
            disposers = [];
            try {
                disposers.push(host.events.onExecutionSettled(handle));
            }
            catch (cause) {
                logger.warn?.('marshal-superagent: event subscription failed: ' + (cause instanceof Error ? cause.message : String(cause)));
            }
            try {
                host.publish({ ready: true, extension: SUPERAGENT_EXTENSION_ID, settledCount, lastSettledAt });
            }
            catch {
                // A board that serves no publish face still runs the event path.
            }
            onStart?.(host);
        },
        stop() {
            for (const dispose of disposers.splice(0)) {
                try { dispose(); }
                catch { /* teardown is best-effort */ }
            }
            host = undefined;
            onStop?.();
        },
        summary() {
            return { ready: host !== undefined, settledCount, lastSettledAt };
        },
    };
}
