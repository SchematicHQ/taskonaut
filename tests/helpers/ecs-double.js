/**
 * Test doubles for the AWS ECS client.
 *
 * The CLI only ever touches the ECS client through the handful of operations
 * below, so these fakes exercise the real code paths (pagination, batching,
 * retries) without any network access.
 */

/** Builds a task definition ARN. */
export const tdArn = (revision, family = "app") =>
  `arn:aws:ecs:us-east-1:111122223333:task-definition/${family}:${revision}`;

/** Builds a cluster ARN. */
export const clusterArn = (name) =>
  `arn:aws:ecs:us-east-1:111122223333:cluster/${name}`;

/** Builds a task ARN. */
export const taskArn = (id, cluster = "prod") =>
  `arn:aws:ecs:us-east-1:111122223333:task/${cluster}/${id}`;

/** Builds a service ARN. */
export const serviceArn = (name, cluster = "prod") =>
  `arn:aws:ecs:us-east-1:111122223333:service/${cluster}/${name}`;

/**
 * Returns a handler that serves `items` under `key` in pages of `pageSize`,
 * using the same opaque-token protocol the ECS APIs use.
 *
 * @param {string} key - Response field holding the page.
 * @param {Array} items - Full result set.
 * @param {number} pageSize - Items per page.
 * @returns {Function} Handler for makeEcs.
 */
export function paged(key, items, pageSize = Math.max(items.length, 1)) {
  return async ({ nextToken }) => {
    const start = nextToken ? Number(nextToken) : 0;
    const page = items.slice(start, start + pageSize);
    const end = start + page.length;

    return {
      [key]: page,
      nextToken: end < items.length ? String(end) : undefined,
    };
  };
}

/**
 * Wraps handlers in a recording ECS double.
 *
 * Every call is captured so tests can assert on the requests made -- page
 * sizes, batch sizes and status filters are behaviour, not implementation
 * detail, because AWS defaults silently truncate otherwise-correct code.
 *
 * @param {Object} handlers - Map of ECS operation name to async handler.
 * @returns {Object} ECS double with `calls` and `callsTo`.
 */
export function makeEcs(handlers = {}) {
  const calls = [];

  const ecs = {
    calls,
    callsTo: (name) => calls.filter((call) => call.name === name),
  };

  for (const [name, handler] of Object.entries(handlers)) {
    ecs[name] = async (params) => {
      calls.push({ name, params });
      return handler(params);
    };
  }

  return ecs;
}

/** Builds an error shaped like an SDK throttling exception. */
export function throttlingError(name = "ThrottlingException") {
  const err = new Error("Rate exceeded");
  err.name = name;
  return err;
}

/**
 * Returns a handler that fails the first `failures` calls with `error`, then
 * delegates to `handler`.
 *
 * @param {number} failures - How many calls to fail.
 * @param {Error|Function} error - Error (or factory) to throw.
 * @param {Function} handler - Handler for the remaining calls.
 * @returns {Function} Handler for makeEcs.
 */
export function failFirst(failures, error, handler) {
  let seen = 0;
  return async (params) => {
    seen += 1;
    if (seen <= failures) throw typeof error === "function" ? error() : error;
    return handler(params);
  };
}
