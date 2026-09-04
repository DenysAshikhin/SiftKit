import { InferenceToolCallParser } from './tool-call-parser.js';
import type { LiveContentClassification, LiveContentResult } from './types.js';

export type LiveContentSnapshot = {
  classification: LiveContentClassification;
  rawText: string;
  narrationText: string;
};

export function toLiveContentResult(snapshot: LiveContentSnapshot): LiveContentResult {
  return { ...snapshot, text: snapshot.narrationText };
}

export function completeLiveContent(
  rawText: string,
  hasNativeToolCalls: boolean,
  onContent?: (snapshot: LiveContentSnapshot) => void,
): LiveContentResult {
  const classifier = new LiveContentClassifier();
  classifier.observeContent(rawText);
  if (hasNativeToolCalls) classifier.observeNativeToolCall();
  const snapshot = classifier.finish();
  onContent?.(snapshot);
  return toLiveContentResult(snapshot);
}

export class LiveContentClassifier {
  private readonly parser = new InferenceToolCallParser();
  private rawText = '';
  private nativeToolBoundary: number | null = null;

  observeContent(accumulatedContent: string): LiveContentSnapshot {
    this.rawText = accumulatedContent;
    if (this.nativeToolBoundary !== null) {
      const visibleText = accumulatedContent.slice(0, this.nativeToolBoundary);
      return this.snapshot('tool_control', this.parser.projectStreamText(visibleText).narrationText);
    }
    const projection = this.parser.projectStreamText(accumulatedContent);
    return this.snapshot(projection.classification, projection.narrationText);
  }

  observeNativeToolCall(): LiveContentSnapshot {
    this.nativeToolBoundary = this.rawText.length;
    return this.snapshot('tool_control', this.parser.projectStreamText(this.rawText).narrationText);
  }

  finish(): LiveContentSnapshot {
    const projection = this.parser.projectStreamText(this.rawText);
    if (this.nativeToolBoundary !== null) {
      const visibleText = this.rawText.slice(0, this.nativeToolBoundary);
      return this.snapshot('tool_control', this.parser.projectStreamText(visibleText).narrationText);
    }
    if (projection.classification === 'undecided') {
      return this.snapshot('undecided', '');
    }
    return this.snapshot(projection.classification, projection.narrationText);
  }

  private snapshot(classification: LiveContentClassification, narrationText: string): LiveContentSnapshot {
    return { classification, rawText: this.rawText, narrationText };
  }
}
