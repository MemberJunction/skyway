---
"@memberjunction/skyway-core": patch
---

Per-migration mode now reports a failed batch's real error even when the transaction was already aborted by the server. A request timeout or severe error aborts the transaction, the follow-up rollback then throws "Transaction has been aborted", and that error used to escape and replace the batch's own message (for example the timeout). The rollback is now guarded the same way per-run mode already guards it.
