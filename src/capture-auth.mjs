// @ts-check
/**
 * The seam between a capture and its login (ADR 0038): sign in over the browser protocol BEFORE the transcript
 * begins, and destroy the session AFTER the capture, whatever the capture did.
 *
 * `auth-flow.mjs` is the interpreter and knows nothing of the capture; this file is the only place the two meet,
 * so `capture-core.mjs` gains two calls and no logic. The window was launched at the requested page exactly as an
 * unauthenticated capture launches it (so the launch is the path this worker has always taken); the login then
 * runs in that window, and the requested page is loaded again once signed in, through `navigateExisting` — the same
 * navigation the browser-reuse path makes, which records where redirects landed for the landed-on-the-page check.
 *
 * THE PURGE IS NOT OPTIONAL AND NOT BEST-EFFORT ABOUT WHAT IT REPORTS. The worker's browser profile lives on disk
 * and persists between captures, so a session cookie left in it is the NEXT capture's session. `end` clears cookies,
 * cache and storage for the origin, closes the protocol connection, and RECORDS whether that worked
 * (`authPurge`, or `authPurgeFailed` with the reason). It does not throw: it runs in a `finally`, and an exception
 * there would replace the capture's own outcome. The caller closes the browser after it.
 *
 * A plan that carries a saved state (`plan.state`, ADR 0038 amendment 7) signs in from it instead of from the login's steps,
 * and needs nothing here: its entries were read from the person's file when the request was validated (`withLoadedState`), the
 * variables it checks are the flow's only, and the purge below is what ends the session the state made, exactly as for a login.
 */
import { CDP_PORT, navigateExisting } from "./browser-session.mjs";
import { markWindowNavigatedByLogin } from "./capture-setup.mjs";
import { assertCredentialsPresent, openCdpDriver, purgeSession, signIn } from "./auth-flow.mjs";
import { errorText } from "./error-text.mjs";

/**
 * @param {{ plan: import("./auth-flow.mjs").AuthPlan, url: string,
 *   diag: { mark: (event: string, detail?: Record<string, unknown>) => void }, env?: Record<string, string | undefined>,
 *   port?: number }} request
 * @returns {Promise<{ end: () => Promise<void> }>}
 */
export async function beginAuthentication({ plan, url, diag, env = process.env, port = CDP_PORT }) {
  // Before a browser is driven at all: a login that runs with an empty field counts against an account's lockout.
  assertCredentialsPresent(plan, env);
  const driver = await openCdpDriver({ port });
  let ended = false;
  const end = async () => {
    if (ended) return;
    ended = true;
    try {
      await purgeSession(driver, url);
      diag.mark("authPurge", { origin: new URL(url).origin });
    } catch (error) {
      diag.mark("authPurgeFailed", { error: errorText(error) });
    }
    await driver.close().catch((error) => diag.mark("authDriverCloseFailed", { error: errorText(error) }));
  };
  try {
    await signIn({
      plan, url, driver, env, mark: (event, detail) => diag.mark(event, detail),
      land: async (target) => {
        try {
          await navigateExisting(target);
          markWindowNavigatedByLogin();
          return { ok: true };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },
    });
  } catch (error) {
    await end();
    throw error;
  }
  return { end };
}
