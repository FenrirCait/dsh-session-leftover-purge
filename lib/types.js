/**
 * The contract every cleanup target implements.
 *
 * Three rules shape this file:
 *  - an adapter never decides *whether* to act (the runtime does), it only
 *    describes what it would do (`plan`) and then does exactly that (`apply`);
 *  - `plan()` is read-only, so `dryRun` and the settings preview share one code
 *    path with the real run;
 *  - nothing here knows about Cordis. `src/index.ts` is the only place that does.
 */
export {};
