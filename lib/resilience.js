function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout(task, { timeoutMs, timeoutMessage }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`)), timeoutMs);

  try {
    return await task(controller.signal);
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`);
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableError(error) {
  const code = error?.code || '';
  const message = String(error?.message || '');
  return [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND'
  ].includes(code) || /timed out|network|fetch failed|temporar|reset/i.test(message);
}

async function retryAsync(operation, options = {}) {
  const {
    retries = 2,
    retryDelayMs = 300,
    shouldRetry = isRetryableError,
    onRetry
  } = options;

  let attempt = 0;
  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error, attempt)) {
        throw error;
      }

      if (onRetry) onRetry(error, attempt + 1);
      await sleep(retryDelayMs * (attempt + 1));
      attempt += 1;
    }
  }
}

module.exports = {
  isRetryableError,
  retryAsync,
  withTimeout
};
