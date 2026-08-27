import type {
  ChatToolCallMessage,
  ToolActivityKind,
  ToolActivitySubject,
} from '../types';

export const LIVE_TOOL_RING_DEPTH = 3;

export type ToolActivityGroup = {
  key: string;
  turn: number;
  activityKind: ToolActivityKind;
  subjects: ToolActivitySubject[];
  state: 'active' | 'failed';
  messages: ChatToolCallMessage[];
};

function subjectKey(subject: ToolActivitySubject): string {
  return subject.kind === 'none' ? 'none' : `${subject.kind}:${subject.value}`;
}

function uniqueSubjects(messages: readonly ChatToolCallMessage[]): ToolActivitySubject[] {
  const subjects: ToolActivitySubject[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const subject = message.toolCallActivitySubject;
    const key = subjectKey(subject);
    if (!seen.has(key)) {
      seen.add(key);
      subjects.push(subject);
    }
  }
  return subjects;
}

export function buildToolActivityRing(
  messages: readonly ChatToolCallMessage[],
): ToolActivityGroup[] {
  const groups: ToolActivityGroup[] = [];
  const groupsByKey = new Map<string, ToolActivityGroup>();
  for (const message of messages) {
    const key = `${message.toolCallTurn}:${message.toolCallActivityKind}`;
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.messages.push(message);
      existing.subjects = uniqueSubjects(existing.messages);
      if (message.toolCallExitCode !== null && message.toolCallExitCode !== 0) {
        existing.state = 'failed';
      }
      continue;
    }
    const group: ToolActivityGroup = {
      key,
      turn: message.toolCallTurn,
      activityKind: message.toolCallActivityKind,
      subjects: uniqueSubjects([message]),
      state: message.toolCallExitCode !== null && message.toolCallExitCode !== 0 ? 'failed' : 'active',
      messages: [message],
    };
    groupsByKey.set(key, group);
    groups.push(group);
  }
  return groups.slice(-LIVE_TOOL_RING_DEPTH);
}

function subjectValues(group: ToolActivityGroup, kind: 'file' | 'host'): string[] {
  return group.subjects.flatMap((subject) => subject.kind === kind ? [subject.value] : []);
}

function baseLabel(group: ToolActivityGroup): string {
  switch (group.activityKind) {
    case 'read': {
      const files = subjectValues(group, 'file');
      if (files.length === 1) return `Reading file ${files[0]}…`;
      return files.length > 1 ? 'Reading multiple files…' : 'Reading files…';
    }
    case 'edit': {
      const files = subjectValues(group, 'file');
      if (files.length === 1) return `Editing file ${files[0]}…`;
      return files.length > 1 ? 'Editing multiple files…' : 'Editing files…';
    }
    case 'search':
      return 'Searching code…';
    case 'validate':
      return 'Validating project…';
    case 'web_search':
      return 'Searching the web…';
    case 'web_fetch': {
      const hosts = subjectValues(group, 'host');
      if (hosts.length === 1) return `Loading ${hosts[0]}…`;
      return hosts.length > 1 ? 'Loading multiple pages…' : 'Loading page…';
    }
    case 'command':
      return 'Running command…';
  }
}

export function getToolActivityLabel(group: ToolActivityGroup): string {
  const label = baseLabel(group);
  return group.state === 'failed' ? `${label} failed` : label;
}
