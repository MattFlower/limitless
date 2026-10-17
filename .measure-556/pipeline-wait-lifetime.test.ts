import { afterEach, expect, mock, test } from 'bun:test';
import type { Factory } from '../src/app.ts';
import { pipelineSetup, waitFor } from '../test/pipeline-support.ts';

pipelineSetup({ home: '', repoDir: '', factory: null });
const entered = Promise.withResolvers<void>();
const read = mock(() => {
  entered.resolve();
  return { status: 'running' };
});
const unsubscribe = mock(() => {});
const fixture = { store: { getRun: read, subscribe: () => unsubscribe } } as unknown as Factory;
let result: Promise<unknown>;
afterEach(async () => {
  expect(await result).toMatchObject({ name: 'AbortError' });
  expect(read).toHaveBeenCalledTimes(1);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(read).toHaveBeenCalledTimes(1);
});
test('pipeline wait stops reading when its test ends', async () => {
  result = waitFor(fixture, 'pending', ['succeeded'], 50).catch((error: unknown) => error);
  await entered.promise;
});
