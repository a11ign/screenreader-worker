---
"@a11ign/screenreader-worker": minor
---

The form-control census reports `pasteCancelled` on each password field: whether a cancelable `paste` event dispatched at it was cancelled, which reads the outcome of `onpaste="return false"` and of a `paste` listener alike. Other controls carry no such key.

`CAPTURE_PROTOCOL_VERSION` moves from 22 to 23, because the capture cache would otherwise keep serving captures that lack the field. Captures cached at 22 are not reused.
