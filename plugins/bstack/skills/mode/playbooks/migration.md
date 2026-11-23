# Migration

For schema changes, stored data and file or payload formats that something else reads (another app, n8n, an export, a dealer). Always tier 2.

1. **List the consumers**: who reads the table, file or payload, found in code and in the flow definitions, not from memory. Note the fields each one actually uses.
2. **Plan the order** so nothing reads a shape that does not exist yet: usually expand (add the new shape and keep the old), deploy, switch consumers, then contract in a later PR. Write the order in the PR.
3. **Backup and rollback.** State how to restore: the backup that exists before deploy and the command to restore it.
4. **Make it idempotent.** Running it twice gives the same result. Test that explicitly.
5. **Test on realistic fixtures**: a copy of the real shape (anonymised), including the messy rows: nulls, duplicates, old formats, encodings. Assert row counts and key values before and after.
6. **Contract test for consumers**: a fixture of the payload or file header that consumers read, so a later rename fails CI.
7. **Run `bstack:interrogate`**, then **ship** ([ship](ship.md)). Deploy only on the user's OK, in the planned order.

**Gate to ship:** idempotency test, fixture before/after counts, consumer list with the order, and the rollback command.
