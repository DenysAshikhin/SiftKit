import React from 'react';
import { createRoot } from 'react-dom/client';
import { DurableChatApprovalSchema, DurableChatQuestionSchema } from '@siftkit/contracts';
import '../src/styles.css';
import { ChatTab } from '../src/tabs/ChatTab';
import { ChatRuntimeHub } from '../src/lib/chat-runtime-hub';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import { HOSTILE_PATH, OVERFLOW_PRESENT, SHORT_ANSWER, SHORT_QUESTION, UNBROKEN, type OverflowReport } from './chat-overflow-content.js';
import { REPO_AGENT_PRESET, SESSION_A, buildDefaultStore, buildProps, msg, orchestratorProps } from './chat-tab-fixture.js';

/** Real ChatTab scenarios filled with content that cannot wrap; tests/process/chat-overflow.test.ts drives this page in headless Chrome. */
const WIDE_TABLE = [
  `| ${Array.from({ length: 12 }, (_, index) => `heading ${index}`).join(' | ')} |`,
  `| ${Array.from({ length: 12 }, () => '---').join(' | ')} |`,
  `| ${Array.from({ length: 12 }, () => UNBROKEN.slice(0, 48)).join(' | ')} |`,
].join('\n');
const WIDE_IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="40"/>')}`;
const MARKDOWN = [
  `Plain ${UNBROKEN}`, `Link https://example.com/${HOSTILE_PATH}`, `Inline \`${UNBROKEN}\``,
  `\`\`\`\nconst line = '${UNBROKEN}';\n\`\`\``, WIDE_TABLE, `![wide](${WIDE_IMAGE})`,
].join('\n\n');
const SESSION = { ...SESSION_A, planRepoRoot: `C:/${HOSTILE_PATH}`, messages: [
  msg({ id: 'u', role: 'user', kind: 'user_text', content: `${UNBROKEN} https://example.com/${HOSTILE_PATH}` }),
  msg({ id: 't', kind: 'assistant_thinking', content: MARKDOWN, sourceRunId: 'run-1' }),
  msg({ id: 'c', kind: 'assistant_tool_call', content: UNBROKEN, toolCallCommand: `rg ${UNBROKEN} ${HOSTILE_PATH}`,
    toolCallActivityKind: 'search', toolCallActivitySubject: { kind: 'file', value: HOSTILE_PATH }, toolCallTurn: 1,
    toolCallMaxTurns: 5, toolCallExitCode: 1, toolCallStatus: 'done', toolCallExecutionState: 'completed', sourceRunId: 'run-1' }),
  msg({ id: 'a', kind: 'assistant_answer', content: MARKDOWN, sourceRunId: 'run-1' }),
  msg({ id: 'd', role: 'user', kind: 'repo_agent_approval', content: '', approvalDecision: 'approve', approvalToolName: 'bash',
    approvalCommand: `npm test -- ${UNBROKEN}`, approvalReason: null, sourceRunId: 'run-1' }),
  msg({ id: 's', role: 'user', kind: 'user_text', content: SHORT_QUESTION }),
  msg({ id: 'r', kind: 'assistant_answer', content: SHORT_ANSWER, sourceRunId: 'run-2' }),
] };
const TIMES = { requestedAtUtc: '2026-09-22T00:00:00.000Z', expiresAtUtc: '2999-01-01T00:00:00.000Z', outcome: null, decidedAtUtc: null, actionable: true };
const question = DurableChatQuestionSchema.parse({ questionId: '4f9c1f9a-0000-4000-8000-00000000000e', toolCallId: 'call',
  question: UNBROKEN, choices: [UNBROKEN, `${UNBROKEN} b`, 'short'], ...TIMES });
const approval = DurableChatApprovalSchema.parse({ runId: '4f9c1f9a-0000-4000-8000-000000000000', approvalId: '4f9c1f9a-0000-4000-8000-000000000001',
  toolName: UNBROKEN.slice(0, 80), command: `npm test -- ${UNBROKEN}`, reviewPayload: UNBROKEN, toolCallId: 'native-call', mode: 'interactive', ...TIMES });

function questionHub(): ChatRuntimeHub {
  return new ChatRuntimeHub(buildDefaultStore(SESSION.id)
    .apply({ kind: 'snapshot', sessionId: SESSION.id, snapshot: chatSnapshot({ sessionId: SESSION.id, operationKind: 'message', question, warnings: [UNBROKEN] }) })
    .apply({ kind: 'control-error', sessionId: SESSION.id, message: UNBROKEN }));
}

function approvalHub(): ChatRuntimeHub {
  return new ChatRuntimeHub(buildDefaultStore(SESSION.id)
    .apply({ kind: 'snapshot', sessionId: SESSION.id, snapshot: chatSnapshot({ sessionId: SESSION.id, approval }) }));
}

const SCENARIOS = {
  question: buildProps({ selectedSession: SESSION, runtimeHub: questionHub() }),
  approval: buildProps({ selectedSession: SESSION, runtimeHub: approvalHub(), chatMode: 'repo-agent', isRepoToolMode: true,
    isDirectChatMode: false, webPresets: [REPO_AGENT_PRESET], selectedChatPreset: REPO_AGENT_PRESET }),
  orchestrator: orchestratorProps({ selectedSession: { ...SESSION, planRepoRoot: 'C:/repo' } }),
};

declare global {
  interface Window { runOverflow?: () => Promise<OverflowReport> }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function describe(element: Element): string {
  return `${element.tagName.toLowerCase()}${[...element.classList].map((name) => `.${name}`).join('')} "${(element.textContent ?? '').slice(0, 30)}"`;
}

/** Boxes that cross their parent's right edge; a parent that scrolls owns its overflow, and out-of-flow boxes are placed on purpose. */
function escapesWithin(root: Element): string[] {
  const found: string[] = [];
  const visit = (parent: Element): void => {
    const edge = parent.getBoundingClientRect().right + 0.5;
    const scrolls = getComputedStyle(parent).overflowX !== 'visible';
    for (const child of parent.children) {
      const { position } = getComputedStyle(child);
      const placed = position === 'absolute' || position === 'fixed';
      if (!scrolls && !placed && child.getBoundingClientRect().right > edge) found.push(`${describe(child)} escapes ${describe(parent)}`);
      visit(child);
    }
  };
  visit(root);
  return found;
}

/** Outermost user bubbles sit on the right of their column and assistant bubbles on the left; a short bubble hugs its content. */
function misalignedWithin(scenario: Element): string[] {
  const outermost = [...scenario.querySelectorAll('.msg')].filter((bubble) => bubble.parentElement?.closest('.msg') === null);
  return outermost.flatMap((bubble) => {
    const parent = bubble.parentElement;
    if (!parent) return [`${describe(bubble)} has no column`];
    const box = bubble.getBoundingClientRect();
    const column = parent.getBoundingClientRect();
    const maxWidth = column.width * Number.parseFloat(getComputedStyle(bubble).maxWidth) / 100;
    const short = [SHORT_QUESTION, SHORT_ANSWER].some((text) => (bubble.textContent ?? '').includes(text));
    return [
      bubble.classList.contains('user') && Math.abs(box.right - column.right) > 1 ? `${describe(bubble)} is not right-aligned` : '',
      bubble.classList.contains('ai') && Math.abs(box.left - column.left) > 1 ? `${describe(bubble)} is not left-aligned` : '',
      short && box.width >= maxWidth - 1 ? `${describe(bubble)} takes its full max width` : '',
    ].filter(Boolean);
  });
}

/** A chunk's placeholder height must resolve to the row estimate times the chunk size ChatTab sets on it. */
function estimateErrorsWithin(scenario: Element): string[] {
  return [...scenario.querySelectorAll('.msgs-chunk')].flatMap((chunk) => {
    const style = getComputedStyle(chunk);
    const expected = `auto ${String(Number(style.getPropertyValue('--chunk-rows')) * Number.parseFloat(style.getPropertyValue('--row-estimate')))}px`;
    const actual = style.getPropertyValue('contain-intrinsic-block-size');
    return actual === expected ? [] : [`${describe(chunk)} estimates "${actual}", not "${expected}"`];
  });
}

function measure(scenario: Element): OverflowReport['scenarios'][number] {
  const main = scenario.querySelector('.chat-main');
  const log = scenario.querySelector('.msgs');
  if (!main || !log) throw new Error('The chat tab did not render its log.');
  return { name: scenario.getAttribute('data-scenario') ?? '', sideways: [main, log].map((element) => element.scrollWidth - element.clientWidth),
    escapes: escapesWithin(main), misaligned: misalignedWithin(scenario), estimateErrors: estimateErrorsWithin(scenario) };
}

async function runOverflow(): Promise<OverflowReport> {
  for (let tries = 0; !document.querySelector('.orchestrator-run') && tries < 200; tries += 1) await pause(20);
  for (const button of document.querySelectorAll('button')) if (button.textContent === 'Reject…') button.click();
  // Opening a disclosure can reveal nested ones, so open until none is left closed.
  for (let round = 0; round < 5; round += 1) {
    for (const summary of document.querySelectorAll('details:not([open]) > summary')) if (summary instanceof HTMLElement) summary.click();
    await pause(50);
  }
  return { present: OVERFLOW_PRESENT.filter((selector) => document.querySelector(selector)),
    scenarios: [...document.querySelectorAll('[data-scenario]')].map(measure) };
}

const host = document.getElementById('root');
if (!host) throw new Error('The overflow page has no root.');
createRoot(host).render(<>{Object.entries(SCENARIOS).map(([name, props]) => (
  <div key={name} className="view on" data-scenario={name} style={{ width: 760, height: 1600, flex: 'none' }}><ChatTab {...props} /></div>
))}</>);
window.runOverflow = runOverflow;
