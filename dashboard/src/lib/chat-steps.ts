import type { RunDetailResponse } from '../types';
import {
  formatStepContextUsed,
  isRecord,
  readStringField,
} from './format';

export type RepoSearchChatStep = {
  id: string;
  prompt: string | null;
  command: string;
  output: string;
  contextUsed: string | null;
};

export function buildRepoSearchChatSteps(events: RunDetailResponse['events']): RepoSearchChatStep[] {
  const contextUsedByCommandOrder: Array<string | null> = [];
  for (const event of events) {
    if (event.kind !== 'turn_command_result' || !isRecord(event.payload)) {
      continue;
    }
    contextUsedByCommandOrder.push(formatStepContextUsed(event.payload));
  }

  const stepsFromScorecard: RepoSearchChatStep[] = [];
  let contextUsedIndex = 0;
  for (const event of events) {
    if (event.kind !== 'run_done' || !isRecord(event.payload)) {
      continue;
    }
    const scorecard = isRecord(event.payload.scorecard) ? event.payload.scorecard : null;
    const tasks = scorecard && Array.isArray(scorecard.tasks) ? scorecard.tasks : [];
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex];
      if (!isRecord(task)) {
        continue;
      }
      const question = readStringField(task, 'question');
      const commands = Array.isArray(task.commands) ? task.commands : [];
      for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
        const commandRecord = commands[commandIndex];
        if (!isRecord(commandRecord)) {
          continue;
        }
        const command = readStringField(commandRecord, 'command');
        const output = readStringField(commandRecord, 'output');
        if (!command || !output) {
          continue;
        }
        stepsFromScorecard.push({
          id: `task-${taskIndex + 1}-step-${commandIndex + 1}`,
          prompt: commandIndex === 0 ? question : null,
          command,
          output,
          contextUsed: contextUsedByCommandOrder[contextUsedIndex++] ?? null,
        });
      }
    }
  }
  if (stepsFromScorecard.length > 0) {
    return stepsFromScorecard;
  }

  const stepsFromTurns: RepoSearchChatStep[] = [];
  for (const event of events) {
    if (event.kind !== 'turn_command_result' || !isRecord(event.payload)) {
      continue;
    }
    const taskId = readStringField(event.payload, 'taskId');
    const turn = event.payload.turn;
    const command = readStringField(event.payload, 'command');
    const output = readStringField(event.payload, 'insertedResultText') || readStringField(event.payload, 'output');
    if (!taskId || !Number.isFinite(turn as number) || !command || !output) {
      continue;
    }
    stepsFromTurns.push({
      id: `${taskId}-step-${String(turn)}`,
      prompt: null,
      command,
      output,
      contextUsed: formatStepContextUsed(event.payload),
    });
  }
  return stepsFromTurns;
}
