import { LlamaCppToolCallParser } from './tool-call-parser.js';

export type LiveContentClassification = 'undecided' | 'narration' | 'tool_control';

export type LiveContentSnapshot = {
  classification: LiveContentClassification;
  rawText: string;
  narrationText: string;
};

export class LiveContentClassifier {
  private readonly parser = new LlamaCppToolCallParser();
  private rawText = '';
  private narrationText = '';
  private toolControlSeen = false;

  observeContent(accumulatedContent: string): LiveContentSnapshot {
    this.rawText = accumulatedContent;
    if (this.toolControlSeen) {
      if (this.narrationText.startsWith(accumulatedContent)) this.narrationText = accumulatedContent;
      return this.snapshot('tool_control');
    }
    const projection = this.parser.projectStreamText(accumulatedContent);
    this.narrationText = projection.narrationText;
    if (projection.classification === 'tool_control') this.toolControlSeen = true;
    return this.snapshot(projection.classification);
  }

  observeNativeToolCall(): LiveContentSnapshot {
    if (!this.toolControlSeen) {
      this.narrationText = this.parser.projectStreamText(this.rawText).narrationText;
      this.toolControlSeen = true;
    }
    return this.snapshot('tool_control');
  }

  finish(): LiveContentSnapshot {
    if (this.toolControlSeen) return this.snapshot('tool_control');
    const projection = this.parser.projectStreamText(this.rawText);
    if (projection.classification === 'undecided') {
      this.narrationText = '';
      return this.snapshot('undecided');
    }
    this.narrationText = projection.narrationText;
    return this.snapshot(projection.classification);
  }

  private snapshot(classification: LiveContentClassification): LiveContentSnapshot {
    return { classification, rawText: this.rawText, narrationText: this.narrationText };
  }
}
