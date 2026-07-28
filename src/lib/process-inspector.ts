import { kill } from 'node:process';

export interface ProcessInspector {
  isAlive(pid: number): boolean;
}

export class NodeProcessInspector implements ProcessInspector {
  isAlive(pid: number): boolean {
    try {
      kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
