export const CHAT_QUEUE_METADATA_PREFIX = 'chat_queue:';
export const CHAT_PROJECTION_METADATA_PREFIX = 'chat_projection:';
const CHAT_QUEUE_RECEIPT_PREFIX = 'chat_queue_receipt:';

export const chatMetadataKey = {
  queue(sessionId: string): string { return `${CHAT_QUEUE_METADATA_PREFIX}${sessionId}`; },
  projection(operationId: string): string { return `${CHAT_PROJECTION_METADATA_PREFIX}${operationId}`; },
  receiptPrefix(sessionId: string): string { return `${CHAT_QUEUE_RECEIPT_PREFIX}${sessionId}:`; },
  receipt(sessionId: string, receiptId: string): string { return `${CHAT_QUEUE_RECEIPT_PREFIX}${sessionId}:${receiptId}`; },
};
