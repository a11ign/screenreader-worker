// A SESSION IN A BROWSER WITH `--remote-debugging-port` IS REACHABLE BY ANYTHING THAT CAN REACH THE PORT (ADR 0038,
// amendment 4, `ceo` on #2275).
//
// Chrome and Edge bind the port to loopback BY DEFAULT, and the amendment's words are: "the build row must assert it
// (a test that the launched args carry no non-loopback `--remote-debugging-address`) rather than believe it". So this
// file asserts it, over the arguments the worker REALLY launches with (`reusableArgs(url, browserArgs(...))`, which
// both `launchBrowser` and the reusable launch use), for EVERY browser the worker can be configured to drive.
//
// The predicate has its own positive controls: a check that has never been seen to fire proves nothing about a
// launch line it never fails on.
import { test } from "node:test";
import assert from "node:assert/strict";

import { BROWSERS, browserArgs } from "./browsers.mjs";
import { CDP_PORT, reusableArgs } from "./browser-session.mjs";

const URL_UNDER_TEST = "https://app.example.test/orders";

/** Every value the launch line gives `--remote-debugging-address`, in either spelling Chromium reads. */
function debuggingAddresses(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => {
    if (arg.startsWith("--remote-debugging-address=")) return [arg.slice("--remote-debugging-address=".length)];
    return arg === "--remote-debugging-address" ? [args[index + 1] ?? ""] : [];
  });
}

const isLoopback = (address: string) => address === "localhost" || address === "::1" || address === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);

const nonLoopbackAddresses = (args: readonly string[]) => debuggingAddresses(args).filter((address) => !isLoopback(address));

const launchArgs = (id: keyof typeof BROWSERS) => reusableArgs(URL_UNDER_TEST, browserArgs(BROWSERS[id], URL_UNDER_TEST));

test("POSITIVE CONTROL: the predicate fires on every way of opening the port to the segment", () => {
  for (const bad of ["0.0.0.0", "::", "[::]", "192.0.2.10", "worker.example.test", "127.0.0.1.evil.test", ""]) {
    assert.deepEqual(nonLoopbackAddresses([`--remote-debugging-address=${bad}`]), [bad], `= form: ${JSON.stringify(bad)}`);
    assert.deepEqual(nonLoopbackAddresses(["--remote-debugging-address", bad]), [bad], `two-argument form: ${JSON.stringify(bad)}`);
  }
  // And it stays quiet for the loopback spellings, so it is not simply "any --remote-debugging-address".
  for (const good of ["127.0.0.1", "127.9.9.9", "::1", "[::1]", "localhost"]) {
    assert.deepEqual(nonLoopbackAddresses([`--remote-debugging-address=${good}`]), [], good);
  }
  assert.deepEqual(nonLoopbackAddresses([`--remote-debugging-port=${CDP_PORT}`]), []);
});

test("AMENDMENT 4: no browser this worker can drive is launched with a non-loopback --remote-debugging-address", () => {
  const ids = Object.keys(BROWSERS) as Array<keyof typeof BROWSERS>;
  assert.ok(ids.length >= 2, "the population is the worker's browsers: Edge and at least one more");
  for (const id of ids) {
    const args = launchArgs(id);
    assert.deepEqual(nonLoopbackAddresses(args), [], `${id}: ${args.join(" ")}`);
    // The port itself is on the launch line exactly once, so the assertion above is about a line that opens one.
    assert.equal(args.filter((arg) => arg.startsWith("--remote-debugging-port=")).length, 1, id);
    // No flag that would open the protocol to another channel either: a pipe or an allowed-origins list.
    assert.ok(!args.some((arg) => arg.startsWith("--remote-debugging-pipe")), id);
    assert.ok(!args.some((arg) => arg.startsWith("--remote-allow-origins")), id);
  }
});

test("the launch line cannot gain an address from the environment", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      A11Y_BROWSER_ARGS: "--remote-debugging-address=0.0.0.0", BROWSER_ARGS: "--remote-debugging-address=0.0.0.0",
      A11Y_REMOTE_DEBUGGING_ADDRESS: "0.0.0.0", REMOTE_DEBUGGING_ADDRESS: "0.0.0.0",
    });
    for (const id of Object.keys(BROWSERS) as Array<keyof typeof BROWSERS>) {
      assert.deepEqual(nonLoopbackAddresses(launchArgs(id)), [], id);
    }
  } finally {
    for (const key of ["A11Y_BROWSER_ARGS", "BROWSER_ARGS", "A11Y_REMOTE_DEBUGGING_ADDRESS", "REMOTE_DEBUGGING_ADDRESS"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
