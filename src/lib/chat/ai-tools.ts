import type { ChatCompletionTool } from 'openai/resources/chat/completions';

export const ORDER_LOOKUP_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'lookup_order',
    description: 'Look up a customer order to get tracking status and order details. Requires BOTH the order ID (or tracking ID) and the complete phone number on the order (all 10 digits). Call it as soon as the customer has given both, even across separate messages. A last-4 is not enough, and names and emails are not accepted and must never be asked for.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'The order ID or order number (e.g. "#1234", "1234"), or the tracking ID (e.g. "STAB12CD34EF").' },
        phone_number: { type: 'string', description: 'The complete phone number on the order, exactly as the customer typed it (10 digits, with or without +91).' },
      },
      required: ['order_id', 'phone_number'],
    },
  },
};

export const ESCALATE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'escalate_to_human',
    description: 'Hand the conversation to a colleague, who will answer the customer in this same chat. Use for refunds, cancellations, exchanges, returns, replacements, address changes, payment problems, a late, stuck, undeliverable or missing parcel, a customer asking for a person, or anything you cannot answer. Never ask the customer for a phone number and never say anyone will call them.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for the handover, for the team.' },
      },
      required: ['reason'],
    },
  },
};

export const CATEGORIZE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'categorize_conversation',
    description: 'Categorize the conversation based on the customer issue. Call this once when you understand the issue type.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['wrong_tracking', 'refund', 'cancellation', 'others'],
          description: 'The category of the customer issue.',
        },
      },
      required: ['category'],
    },
  },
};
