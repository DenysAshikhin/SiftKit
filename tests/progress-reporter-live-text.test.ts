import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressWriter, SilentProgressWriter } from '../src/lib/progress-writer.js';
import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';

class StubWriter extends ProgressWriter<RepoSearchProgressEvent> {
  readonly events: RepoSearchProgressEvent[] = [];

  constructor(private readonly liveText: boolean) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  override get wantsLiveText(): boolean {
    return this.liveText;
  }

  write(event: RepoSearchProgressEvent): void {
    this.events.push(event);
  }
}

function buildReporter(progressWriter: ProgressWriter<RepoSearchProgressEvent>): ProgressReporter {
  return new ProgressReporter({ progressWriter, taskId: 'task', maxTurns: 5, taskStartedAt: Date.now() });
}

test('liveTextEnabled requires both an enabled writer and wantsLiveText', () => {
  assert.equal(buildReporter(new StubWriter(true)).liveTextEnabled, true);
  assert.equal(buildReporter(new StubWriter(false)).liveTextEnabled, false);
});

test('a silent writer disables live text through enabled', () => {
  const reporter = buildReporter(new SilentProgressWriter<RepoSearchProgressEvent>());
  assert.equal(reporter.liveTextEnabled, false);
});

test('ProgressWriter wants live text by default', () => {
  class DefaultWriter extends ProgressWriter<RepoSearchProgressEvent> {
    get enabled(): boolean {
      return true;
    }

    write(_event: RepoSearchProgressEvent): void {}
  }
  assert.equal(new DefaultWriter().wantsLiveText, true);
});
