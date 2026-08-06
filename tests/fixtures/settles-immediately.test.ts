import test from 'node:test';

/**
 * Fixture for tests/run-tests-watchdog.test.ts: the shortest possible passing run.
 *
 * It exists so a nested run can prove the watchdog stayed asleep — anything the run does itself
 * would be noise in an assertion about the budget.
 *
 * It lives under tests/fixtures/ because buildNodeTestArgs only collects the top level of tests/,
 * which keeps it out of the real suite.
 */
test('settles immediately', () => {});
