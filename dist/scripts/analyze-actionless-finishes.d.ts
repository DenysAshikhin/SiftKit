/**
 * Analyze "actionless finish" cases from SiftKit planner debug logs.
 *
 * An "actionless finish" is when the planner model returns JSON with
 * `classification` (and optionally `output`) but NO `action` field,
 * causing a `planner_invalid_response` error.
 *
 * This script checks whether those responses would have been valid
 * final answers if the runtime accepted them.
 */
export {};
