export const MOCK_CHAT_MESSAGES = [
  { role: 'system' as const, content: 'You are a helpful assistant.', timestamp: 1700000000000 },
  { role: 'user' as const, content: 'Hello, how are you?', timestamp: 1700000001000 },
  { role: 'assistant' as const, content: 'I am doing well, thank you!', timestamp: 1700000002000 },
  { role: 'user' as const, content: 'Can you help me with something?', timestamp: 1700000003000 },
  { role: 'assistant' as const, content: 'Of course! What do you need help with?', timestamp: 1700000004000 }
]

export const MOCK_LLM_MESSAGES = [
  { role: 'system' as const, content: 'You are a helpful assistant.' },
  { role: 'user' as const, content: 'Translate this text.' }
]

export const MOCK_TOOL_CALL_MESSAGES = [
  {
    role: 'assistant' as const,
    content: null,
    tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'mock_tool', arguments: '{"key":"value"}' } }
    ]
  },
  { role: 'tool' as const, content: 'Tool result here', tool_call_id: 'call-1' }
]

export const MOCK_DIALOG_MESSAGE = {
  id: 'msg-1',
  role: 'user' as const,
  content: 'Test message',
  timestamp: Date.now()
}

export const MOCK_DIALOG_MESSAGES = [
  { id: 'msg-1', role: 'user' as const, content: 'First message', timestamp: Date.now() - 2000 },
  { id: 'msg-2', role: 'assistant' as const, content: 'Second message', timestamp: Date.now() - 1000 },
  { id: 'msg-3', role: 'user' as const, content: 'Third message', timestamp: Date.now() }
]

export const MOCK_LONG_CONVERSATION = Array.from({ length: 50 }, (_, i) => ({
  id: `msg-${i}`,
  role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
  content: `Message ${i}: ${'x'.repeat(100)}`,
  timestamp: Date.now() - (50 - i) * 1000
}))
