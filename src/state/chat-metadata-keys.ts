export const CHAT_QUEUE_METADATA_PREFIX = 'chat_queue:';
const CHAT_QUEUE_RECEIPT_PREFIX = 'chat_queue_receipt:';

export const chatMetadataKey = {
  queue(sessionId: string): string { return `${CHAT_QUEUE_METADATA_PREFIX}${sessionId}`; },
  receiptPrefix(sessionId: string): string { return `${CHAT_QUEUE_RECEIPT_PREFIX}${sessionId}:`; },
  receipt(sessionId: string, receiptId: string): string { return `${CHAT_QUEUE_RECEIPT_PREFIX}${sessionId}:${receiptId}`; },
};
