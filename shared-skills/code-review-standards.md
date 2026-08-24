---
name: code-review-standards
description: What a review comment should say, and what to leave alone — reach for this when reviewing a diff or a pull request.
created: 2026-08-24
status: active
---

Review the diff that is there, not the one you would have written.

**Say the consequence, not the preference.** A comment worth leaving names what
breaks and under which input. "This throws when `items` is empty" is a review;
"I would use a guard clause here" is a style note, and style notes belong to the
formatter.

**Separate the blocking from the rest.** Mark which comments must be addressed
before merge and which are observations. A review where everything reads equally
urgent gets triaged by the author guessing.

**Check the test, not just the code.** A change that needed a test edited to land
is a change worth asking about: the assertion may have been describing a bug.

**Leave alone:** formatting a tool owns, naming that is merely not your
preference, and refactors of code the diff only moved.
