import test from 'node:test';
import assert from 'node:assert/strict';

import { SecretScanner } from '../src/assistant/domain/secrets.js';

const scanner = new SecretScanner();

test('detects common credential shapes', () => {
  const cases = [
    'my key is sk-abcdefghijklmnopqrstuvwxyz012345',
    'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
    'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----',
    'password = hunter2correcthorse',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ.sig',
    'postgres://admin:s3cretpass@db.internal:5432/app',
  ];
  for (const text of cases) {
    const result = scanner.scan(text);
    assert.equal(result.containsSecret, true, `should flag: ${text}`);
    assert.equal(result.sensitivityFloor, 'secret_prohibited');
    assert.ok(result.matchedRuleIds.length > 0);
  }
});

test('ordinary technical prose is not a secret', () => {
  const result = scanner.scan('I run a local inference engine with a 32k context on an RTX 4090.');
  assert.equal(result.containsSecret, false);
  assert.deepEqual(result.matchedRuleIds, []);
  assert.deepEqual(result.topics, []);
  assert.equal(result.sensitivityFloor, 'personal');
});

test('classifies the four confirmation-required topics', () => {
  assert.deepEqual(scanner.scan('my doctor prescribed a new medication').topics, ['health']);
  assert.deepEqual(scanner.scan('my mortgage payment leaves my bank account').topics, ['finance']);
  assert.deepEqual(scanner.scan('my wife and I are getting a divorce').topics, ['relationship']);
  assert.deepEqual(
    scanner.scan('I live at 42 Rosewood Avenue').topics,
    ['precise_location'],
  );
});

test('a sensitive topic raises the floor to sensitive but is not a secret', () => {
  const result = scanner.scan('my doctor prescribed a new medication');
  assert.equal(result.containsSecret, false);
  assert.equal(result.sensitivityFloor, 'sensitive');
});

test('a secret outranks a topic', () => {
  const result = scanner.scan('my bank account password = hunter2correcthorse');
  assert.equal(result.containsSecret, true);
  assert.equal(result.sensitivityFloor, 'secret_prohibited');
  assert.deepEqual(result.topics, ['finance']);
});

test('a topic noun needs a topic-bearing collocation, not a bare word', () => {
  const cases = [
    'I need to investigate the memory bank',
    'the register bank is full so we spill to the stack',
    'we invest a lot of CPU in this loop',
  ];
  for (const text of cases) {
    const result = scanner.scan(text);
    assert.deepEqual(result.topics, [], `should not classify: ${text}`);
    assert.equal(result.sensitivityFloor, 'personal');
  }
});

test('scanning is case-insensitive and reports each rule once', () => {
  const result = scanner.scan('PASSWORD = hunter2correcthorse and password = hunter2correcthorse');
  assert.deepEqual(result.matchedRuleIds, ['assignment_password']);
});
