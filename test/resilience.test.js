const test = require('node:test');
const assert = require('node:assert/strict');

const { isRetryableError, retryAsync, withTimeout } = require('../lib/resilience');

test('isRetryableError recognizes common timeout and network failures', () => {
  assert.equal(isRetryableError({ code: 'ETIMEDOUT', message: 'timed out' }), true);
  assert.equal(isRetryableError({ code: 'EACCES', message: 'permission denied' }), false);
});

test('retryAsync retries retryable failures and eventually succeeds', async () => {
  let attempts = 0;

  const result = await retryAsync(() => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('network reset');
      error.code = 'ECONNRESET';
      throw error;
    }
    return 'ok';
  }, { retries: 3, retryDelayMs: 1 });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('retryAsync stops on non-retryable failures', async () => {
  let attempts = 0;

  await assert.rejects(
    retryAsync(() => {
      attempts += 1;
      const error = new Error('bad request');
      error.code = 'EVALIDATION';
      throw error;
    }, { retries: 3, retryDelayMs: 1 }),
    /bad request/
  );

  assert.equal(attempts, 1);
});

test('withTimeout passes an abort signal and resolves fast operations', async () => {
  const result = await withTimeout(
    async (signal) => {
      assert.equal(typeof signal.aborted, 'boolean');
      return 'done';
    },
    { timeoutMs: 50 }
  );

  assert.equal(result, 'done');
});
