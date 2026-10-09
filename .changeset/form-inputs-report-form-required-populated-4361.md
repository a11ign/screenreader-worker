---
"@a11ign/screenreader-worker": minor
---

The form-control census reports `form` (the index of the owning form in `document.forms`, absent when there is none) and `required` (the attribute, not `aria-required`) on each control, and `populatedFromEarlier` on an email field with an earlier email in the same form: a sentinel is written to the earlier field through the native value setter, `input` and `change` are dispatched, and the answer is whether the later field's value changed to non-empty. Both fields are restored. This is the first census key that writes to the page's fields; it presses no button. Other controls carry no `populatedFromEarlier` key.

`CAPTURE_PROTOCOL_VERSION` moves from 23 to 24, because the capture cache would otherwise keep serving captures that lack the fields. Captures cached at 23 are not reused.
