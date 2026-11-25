// Loaded by the browser test: renders the panel at several sizes and reports where its panes are.
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { OrchestratorActivity, OrchestratorRunState } from '@siftkit/contracts';

import '../src/styles/global.css';
import '../src/styles/chat.css';
import '../src/styles/orchestrator.css';
import { OrchestratorRunPanel } from '../src/components/OrchestratorRunPanel.tsx';
import { orchestratorRunState, orchestratorTaskState } from './orchestrator-fixture.ts';
import type { LayoutReport } from './orchestrator-layout-content.ts';

const AT = '2026-09-23T12:00:00.000Z';
const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
const IDS = Array.from({ length: 30 }, (_, index) => `task-${index}`);
const LONG = 'Five of thirteen areas are done. The web server is being checked now, because everything else talks through it. '.repeat(2).trim();

const STATE: OrchestratorRunState = orchestratorRunState({
  planPath: 'plan.md', planHash: 'h', parentRunIds: ['00000000-0000-4000-8000-000000000009'],
  plan: { goal: 'Audit', constraints: [], finalVerification: [CHECK], tasks: IDS.map((id) => ({ id, title: `Title of ${id}`, why: 'Make sure it is safe.', dependsOn: [],
    workerPresetId: 'repo-agent', readPaths: [], writePaths: ['a.md'], steps: [{ instruction: 'x', expectedResult: 'y' }], verification: [CHECK], acceptance: ['z'], temporaryPaths: [] })) },
  tasks: IDS.map((id, index) => orchestratorTaskState(id, index < 12 ? 'completed' : index === 12 ? 'running' : 'pending')),
  statusLines: Array.from({ length: 40 }, (_, index) => ({ text: `${index} ${LONG}`.slice(0, 240), atUtc: AT })),
});

function activity(turnCount: number): OrchestratorActivity {
  const first = Math.max(1, turnCount - 11);
  return { runId: STATE.runId, schedule: null, children: [], parent: { waitingForModel: false, parked: false, promptTokens: 1, contextTokens: 2, prompt: null, turnCount,
    turns: Array.from({ length: turnCount - first + 1 }, (_, index) => ({ turn: first + index, thinking: 'x '.repeat(400), text: 'Working. '.repeat(120),
      tools: Array.from({ length: 6 }, (_call, call) => ({ toolCallId: `${first + index}-${call}`, command: `read path="${call}"`, status: 'succeeded' as const, output: 'o' })) })) } };
}

// The chat's own nesting: the panel sizes itself by the message pane, not the window.
const frame = document.createElement('div');
frame.style.cssText = 'display: flex; flex-direction: column;';
const messagePane = document.createElement('div');
messagePane.className = 'message-pane';
const scroller = document.createElement('div');
scroller.className = 'msgs';
const host = document.createElement('div');
host.className = 'msgs-content';
scroller.append(host);
messagePane.append(scroller);
frame.append(messagePane);
document.body.append(frame);
const root = createRoot(host);

async function show(turnCount: number, widthPx: number, paneHeightPx = 700): Promise<void> {
  frame.style.height = `${paneHeightPx}px`;
  frame.style.width = `${widthPx + 100}px`;
  host.style.width = `${widthPx}px`;
  flushSync(() => root.render(<OrchestratorRunPanel state={STATE} activity={activity(turnCount)} workPhase={null} lastMessage={null}
    onDecide={() => undefined} onAbort={() => undefined} />));
  await settle();
}

async function settle(): Promise<void> {
  for (let frame = 0; frame < 3; frame += 1) await new Promise((resolve) => { requestAnimationFrame(resolve); });
}

function find(selector: string): HTMLElement {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Nothing matches ${selector}.`);
  return element;
}

const pane = (name: string): HTMLElement => find(`.orch-pane[aria-label="${name}"]`);
const box = (element: HTMLElement) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop });

function runLineVisible(): boolean {
  const line = find('.orch-now').getBoundingClientRect();
  const frame = pane('Orchestrator').getBoundingClientRect();
  return line.height > 0 && line.top >= frame.top - 1 && line.bottom <= frame.bottom + 1;
}

/** With the chat at its end, the panel's first and last pixels are both inside the message pane. */
async function panelFits(paneHeightPx: number): Promise<{ fits: boolean; panelHeight: number; paneHeight: number }> {
  await show(213, 1300, paneHeightPx);
  scroller.scrollTop = scroller.scrollHeight;
  await settle();
  const [panel, view] = [find('.orchestrator-run').getBoundingClientRect(), messagePane.getBoundingClientRect()];
  return { fits: panel.top >= view.top && panel.bottom <= view.bottom, panelHeight: panel.height, paneHeight: pane('Tasks').clientHeight };
}

declare global {
  interface Window { runLayout(): Promise<LayoutReport> }
}

window.runLayout = async (): Promise<LayoutReport> => {
  await show(12, 1300);
  const [left, right] = [pane('Orchestrator').getBoundingClientRect(), pane('Tasks').getBoundingClientRect()];
  const wide = { sideBySide: left.top === right.top && left.right <= right.left + 1, conversation: box(pane('Orchestrator')), tasks: box(pane('Tasks')),
    runLineVisible: runLineVisible(), panelFillsColumn: find('.orchestrator-run').getBoundingClientRect().width === 1300 };
  await show(212, 1300);
  const grown = { conversation: box(pane('Orchestrator')), runLineVisible: runLineVisible() };
  const tasksTop = pane('Tasks').scrollTop;
  pane('Orchestrator').scrollTop = 0;
  await settle();
  await show(213, 1300);
  const scrolledAway = { conversationTop: pane('Orchestrator').scrollTop, tasksMoved: pane('Tasks').scrollTop !== tasksTop };
  find('.orch-now-all').click();
  await settle();
  const list = find('.orch-now-past');
  const expanded = { runLineVisible: runLineVisible(), listHeight: list.clientHeight, listAtEnd: list.scrollHeight - list.clientHeight - list.scrollTop <= 1 };
  const fitted = { short: await panelFits(560), middle: await panelFits(673), tall: await panelFits(1800) };
  await show(213, 600);
  const narrow = { stacked: pane('Tasks').getBoundingClientRect().top >= pane('Orchestrator').getBoundingClientRect().bottom - 1 };
  return { wide, grown, scrolledAway, expanded, fitted, narrow };
};
