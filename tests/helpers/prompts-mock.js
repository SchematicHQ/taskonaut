import { jest } from "@jest/globals";

/**
 * Installs a scripted stand-in for the `prompts` module.
 *
 * The CLI's selection helpers are where the safety guarantees live -- which
 * revisions are even offered, what is pre-checked, what is disabled -- so they
 * need to be driven from tests. `prompts.inject` only supplies answers; this
 * records the questions too, which is what most of those guarantees are about.
 *
 * Must be called before importing index.js.
 *
 * @returns {{answer: Function, asked: Function, reset: Function}} Controls.
 */
export function mockPrompts() {
  const scripted = [];
  const asked = [];

  const promptsMock = jest.fn(async (question) => {
    const questions = Array.isArray(question) ? question : [question];
    asked.push(...questions);

    const response = {};
    for (const q of questions) {
      if (scripted.length === 0) {
        throw new Error(`No scripted answer for prompt "${q.name}"`);
      }

      // A function answer receives the question, so a test can pick from the
      // choices the code actually built rather than restating them.
      const next = scripted.shift();
      response[q.name] = typeof next === "function" ? next(q) : next;
    }
    return response;
  });

  promptsMock.inject = () => {};
  promptsMock.override = () => {};

  jest.unstable_mockModule("prompts", () => ({ default: promptsMock }));

  return {
    /** Queues answers, consumed one per question in order. A function answer
     * is called with the question and its return value used. */
    answer: (...values) => scripted.push(...values),
    /** Every question object passed to prompts so far. */
    asked: () => asked,
    /** The most recent question object. */
    lastAsked: () => asked[asked.length - 1],
    reset: () => {
      scripted.length = 0;
      asked.length = 0;
      promptsMock.mockClear();
    },
  };
}
