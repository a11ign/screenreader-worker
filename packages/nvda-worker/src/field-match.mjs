/**
 * Find the control a forms config NAMED, in what NVDA actually announced.
 *
 * A forms config addresses fields by ACCESSIBLE NAME (ADR 0024), so the worker has to decide whether the
 * control it just landed on is the one the author meant. The authoritative answer is
 * `parseAnnouncement` in `@a11y-witness/evidence` — and this worker CANNOT import it.
 *
 * That is deliberate, not an oversight. The worker depends on `@guidepup/guidepup` and nothing else: it is
 * git-cloned onto Windows boxes and runs under plain node with no build step, so a dependency on compiled
 * TypeScript would put a `dist` on the capture path. CLAUDE.md records what that costs, and the same
 * constraint already produced `namesOf` beside `comparableNames`, pinned equal by a test rather than
 * merged — *"a test written against a shape you did not verify"* is the failure mode, and pinning is the
 * remedy this repo prefers when a copy is genuinely forced.
 *
 * So this is the SECOND implementation, and `field-match.test.ts` holds it against the real grammar over
 * real corpus announcements. It is deliberately WEAKER than the grammar: it does not parse a role, and it
 * makes no claim about which segment is a container. It answers one question — *is this the control the
 * author named?* — and answers it the only way that survives without the grammar.
 */

/**
 * NVDA joins an announcement's parts with ", ", and an accessible name is one whole part.
 *
 * Splitting on the separator rather than substring-matching is what stops `"Search"` matching
 * `"Search results"`, and what stops a name matching the tail of a longer one. It is the same reason
 * `announcement.ts` tokenises rather than running regexes over the whole phrase.
 */
const segments = (announced) => String(announced ?? "").split(",").map((part) => part.trim());

/**
 * Compare the way a person reads it, not the way a byte comparison does.
 *
 * Case-insensitive because NVDA lower-cases roles and passes names through as authored, so a config
 * transcribed by hand from a report will not always match casing. Whitespace is collapsed because an
 * announcement can carry a non-breaking space where the config has an ordinary one — the U+FFFC and
 * U+E604 lessons in a third alphabet, and both of those cost real time before anyone looked at the bytes.
 */
const normalise = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Does this announcement belong to the control the config named?
 *
 * @param {string} announced what NVDA said when we landed on it
 * @param {string} wanted the `field:` name from the config
 * @returns {boolean}
 */
export function matchesFieldName(announced, wanted) {
  const target = normalise(wanted);
  if (target === "") return false;
  return segments(announced).some((part) => normalise(part) === target);
}

/**
 * Does this announcement sit inside the group the config named?
 *
 * `within:` is the PRIMARY disambiguator because it is how a screen reader user tells two "Address line 1"
 * apart, and NVDA announces the group as its own segment on entry. The same segment test therefore answers
 * it — with one caveat kept honest here rather than hidden: NVDA announces a container ONCE on entry and
 * says nothing again until `out of`, so a field several stops inside a group may carry no group segment at
 * all. `within` is a filter on the announcements that DO carry it; it cannot manufacture context NVDA did
 * not repeat. Where it cannot discriminate, `nth` is the fallback, which is why the draft emits both.
 *
 * @param {string} announced
 * @param {string|undefined} within
 * @returns {boolean} true when no group was asked for
 */
export function matchesWithin(announced, within) {
  if (within === undefined || within === null || String(within).trim() === "") return true;
  return matchesFieldName(announced, within);
}

/**
 * Which keystrokes fill this control, given the verb its config entry used.
 *
 * A control's type decides what "supplying a value" means, and the three verbs exist so the config cannot
 * lie about what was done to the page. Returning a DESCRIPTION rather than performing the keystrokes keeps
 * this module pure and therefore testable off Windows — the split that makes `chooseProbe` and
 * `failIfScreenReaderIsMute` testable, applied to filling.
 *
 * @param {{value?: string, choose?: string, check?: boolean}} field
 * @returns {{action: "type", text: string} | {action: "choose", option: string} | {action: "toggle", to: boolean} | null}
 */
export function fillActionFor(field) {
  if (typeof field?.value === "string") return { action: "type", text: field.value };
  if (typeof field?.choose === "string") return { action: "choose", option: field.choose };
  if (typeof field?.check === "boolean") return { action: "toggle", to: field.check };
  // NULL rather than a default. A field with no verb is a config the author has not finished, and the
  // schema refuses it at parse time — so reaching here means the worker was sent something the CLI would
  // not have produced, and guessing would hide that rather than surface it.
  return null;
}
