import { UNSUPPORTED_INPUT_MESSAGE } from './measure.js';
import { extractPromptSection } from './prompt.js';
import type { StructuredModelDecision, SummaryPhase } from './types.js';

export function toMockDecision(decision: StructuredModelDecision): string {
  return JSON.stringify({
    classification: decision.classification,
    raw_review_required: decision.rawReviewRequired,
    output: decision.output,
  });
}

export function buildMockDecision(prompt: string, question: string, phase: SummaryPhase): StructuredModelDecision {
  const inputText = extractPromptSection(prompt, 'Input:');

  if (!inputText.trim() || /unsupported fixture marker/u.test(inputText)) {
    return {
      classification: 'unsupported_input',
      rawReviewRequired: false,
      output: UNSUPPORTED_INPUT_MESSAGE,
    };
  }

  if (/Return only valid JSON/u.test(prompt)) {
    return {
      classification: 'summary',
      rawReviewRequired: false,
      output: '[{"package":"lodash","severity":"high","title":"demo","fix_version":"1.0.0"}]',
    };
  }

  if (/Could not find type "Active_Buffs"/u.test(inputText)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'The smoke run is failing during script compilation. The decisive failure is parse errors in Global.gd for missing types like Active_Buffs, Bases, and Infos.\nRaw review required.',
    };
  }

  if (/TARGET_VALID/u.test(inputText) && /resources still in use at exit/u.test(inputText)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'The run passed numerically but is still not clean. Shutdown integrity failed because the log includes freed-object script errors and resources still in use at exit.\nRaw review required.',
    };
  }

  if (/ACTION_VALIDATE_FAIL/u.test(inputText) && /warp\/set_stay_100pct/u.test(inputText)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'This run failed autonomous-mode validation. The decisive failure is warp/set_stay_100pct because the stay threshold was not set to 100%.\nRaw review required.',
    };
  }

  if (/save_file_loaded/u.test(inputText) && /Global\.gd/u.test(inputText)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'This run is not clean. The log contains repeated script errors on Global.gd, including invalid access to save_file_loaded, Drones, Motherships, and KEY_EXPORT.\nRaw review required.',
    };
  }

  if ((/TEST HARNESS:/u.test(inputText) && /0 failed/u.test(inputText)) || /pass markers alone do not prove/u.test(inputText)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'These logs show explicit numeric pass markers in historical runs. Pass markers alone do not prove the runs were clean because other logs in the same set can still contain script errors or shutdown issues.\nRaw review required.',
    };
  }

  if (phase === 'merge' || question.startsWith('Merge these partial summaries into one final answer')) {
    if (/pass markers alone do not prove|numeric pass markers/i.test(inputText)) {
      return {
        classification: 'summary',
        rawReviewRequired: true,
        output: 'These logs show explicit numeric pass markers in historical runs. Pass markers alone do not prove the runs were clean because other logs in the same set can still contain script errors or shutdown issues.\nRaw review required.',
      };
    }
    if (/run is not clean|script errors/i.test(inputText)) {
      return {
        classification: 'summary',
        rawReviewRequired: true,
        output: 'This run is not clean. The log contains repeated script errors and related runtime failures.\nRaw review required.',
      };
    }
    if (/failed autonomous-mode validation|stay threshold/i.test(inputText)) {
      return {
        classification: 'summary',
        rawReviewRequired: true,
        output: 'This run failed autonomous-mode validation. The decisive failure is warp/set_stay_100pct because the stay threshold was not set to 100%.\nRaw review required.',
      };
    }
    if (/shutdown integrity failed|resources still in use at exit/i.test(inputText)) {
      return {
        classification: 'summary',
        rawReviewRequired: true,
        output: 'The run passed numerically but is still not clean. Shutdown integrity failed because the log includes freed-object script errors and resources still in use at exit.\nRaw review required.',
      };
    }
    if (/failing during script compilation|parse errors/i.test(inputText)) {
      return {
        classification: 'summary',
        rawReviewRequired: true,
        output: 'The smoke run is failing during script compilation. The decisive failure is parse errors in Global.gd for missing types like Active_Buffs, Bases, and Infos.\nRaw review required.',
      };
    }
  }

  if (/Unable to resolve external command/u.test(inputText) || /is not recognized as an internal or external command/u.test(inputText)) {
    return {
      classification: 'command_failure',
      rawReviewRequired: true,
      output: 'The command failed before producing a usable result. The executable could not be resolved in the current environment.\nRaw review required.',
    };
  }

  if (/did tests pass/u.test(question)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'Tests did not pass cleanly. The decisive failures are test_order_processing and test_auth_timeout.\nRaw review required.',
    };
  }

  if (/resources added, changed, and destroyed/u.test(question)) {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: 'This output includes a destructive infrastructure change. The decisive action is destroy aws_db_instance.main.\nRaw review required.',
    };
  }

  return {
    classification: 'summary',
    rawReviewRequired: false,
    output: 'mock summary',
  };
}

export function getMockSummary(prompt: string, question: string, phase: SummaryPhase): string {
  const behavior = process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR?.trim() || '';
  if (behavior === 'throw') {
    throw new Error('mock provider failure');
  }
  if (behavior === 'recursive-merge') {
    return toMockDecision({
      classification: 'summary',
      rawReviewRequired: false,
      output: 'merge summary',
    });
  }

  const token = process.env.SIFTKIT_TEST_TOKEN;
  const decision = buildMockDecision(prompt, question, phase);
  if (token && decision.output === 'mock summary') {
    decision.output = `mock summary ${token}`;
  }
  return toMockDecision(decision);
}
