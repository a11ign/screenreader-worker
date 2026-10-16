/**
 * The identity providers a login's own buttons name: `Continue with Google`, `Sign in with Apple`.
 *
 * ONE definition, read by the screen loop, which never presses one as a form's submit (a11ign#5494), and by the probe
 * path, which never presses one under probe-forms (a11ign#5657). A provider added to one reader and not the other is
 * the defect, so neither keeps a copy of the list.
 */
export const PROVIDER_NAME = /\b(with|using)\s+(google|apple|microsoft|github|facebook)\b/i;
