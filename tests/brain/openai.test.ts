import { describe, expect, it } from 'vitest';
import {
  OpenAIStructuredReasoner,
  openAIOptionsFromEnv,
  openAIRequestBody,
} from '@synq/plugin-openai';
import { brainReasonersFromEnv } from '../../apps/api/src/channel-brain.js';

describe('OpenAI Brain provider', () => {
  it('is selected only when OPENAI_API_KEY is set and labelled honestly', () => {
    expect(brainReasonersFromEnv({})).toBeNull();
    const r = brainReasonersFromEnv({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_MODEL: 'gpt-5.6-luna',
    })!;
    expect(r.label).toBe('openai:gpt-5.6-luna (LIVE)');
    expect(r.structured.provider).toBe('openai');
    expect(r.structured.availability()).toMatchObject({
      providerId: 'OPENAI',
      credentialsPresent: true,
      mode: 'LIVE',
    });
    expect(openAIOptionsFromEnv({}).mode).toBe('REPLAY');
    expect(() => new OpenAIStructuredReasoner({ mode: 'LIVE' })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it('sends max_completion_tokens and no temperature', () => {
    expect(
      openAIRequestBody({
        model: 'm',
        max_tokens: 100,
        temperature: 0,
        messages: [],
      }),
    ).toEqual({
      model: 'm',
      max_completion_tokens: 100,
      messages: [],
    });
  });
});
