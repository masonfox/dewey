export const aiEnvKeys = [
  'AI_PROVIDER', 'AI_MODEL', 'AI_BASE_URL', 'AI_API_KEY',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_API_URL', 'CLAUDE_MODEL',
  'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_AUTH_TOKEN'
];

export function clearAIEnv() {
  for (const key of aiEnvKeys) delete process.env[key];
}
