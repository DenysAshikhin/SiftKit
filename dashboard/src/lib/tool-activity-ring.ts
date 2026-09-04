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
  state: 'active' | 'completed' | 'failed' | 'stopped';
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

function resolveGroupState(messages: readonly ChatToolCallMessage[]): ToolActivityGroup['state'] {
  if (messages.some((message) => message.toolCallExitCode !== null && message.toolCallExitCode !== 0)) {
    return 'failed';
  }
  if (messages.some((message) => message.toolCallStatus === 'running')) return 'active';
  if (messages.some((message) => message.toolCallStatus === 'stopped')) return 'stopped';
  return 'completed';
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
      existing.state = resolveGroupState(existing.messages);
      continue;
    }
    const group: ToolActivityGroup = {
      key,
      turn: message.toolCallTurn,
      activityKind: message.toolCallActivityKind,
      subjects: uniqueSubjects([message]),
      state: resolveGroupState([message]),
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

function activeLabel(group: ToolActivityGroup): string {
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

function completedLabel(group: ToolActivityGroup): string {
  switch (group.activityKind) {
    case 'read': {
      const files = subjectValues(group, 'file');
      if (files.length === 1) return `Read file ${files[0]}`;
      return files.length > 1 ? 'Read multiple files' : 'Read files';
    }
    case 'edit': {
      const files = subjectValues(group, 'file');
      if (files.length === 1) return `Edited file ${files[0]}`;
      return files.length > 1 ? 'Edited multiple files' : 'Edited files';
    }
    case 'search':
      return 'Searched code';
    case 'validate':
      return 'Validated project';
    case 'web_search':
      return 'Searched the web';
    case 'web_fetch': {
      const hosts = subjectValues(group, 'host');
      if (hosts.length === 1) return `Loaded ${hosts[0]}`;
      return hosts.length > 1 ? 'Loaded multiple pages' : 'Loaded page';
    }
    case 'command':
      return 'Ran command';
  }
}

function terminalLabel(group: ToolActivityGroup): string {
  return activeLabel(group).replace(/…$/u, '');
}

export function getToolActivityLabel(group: ToolActivityGroup): string {
  if (group.state === 'completed') return completedLabel(group);
  if (group.state === 'failed') return `${terminalLabel(group)} — failed`;
  if (group.state === 'stopped') return `${terminalLabel(group)} — stopped`;
  return activeLabel(group);
}
