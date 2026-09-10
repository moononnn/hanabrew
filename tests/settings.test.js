import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSettings } from '../tools/tavern-settings.js';

test('tavern-settings 响应会递归隐藏凭据，但保留模型地址', () => {
  const redacted = redactSettings({
    oai_settings: {
      custom_url: 'https://api.example.test/v1',
      custom_model: 'demo-model',
      api_key_custom: 'secret-value',
    },
    apiKey: 'top-level-secret',
    nested: [{ token: 'nested-secret', temperature: 0.7 }],
  });
  assert.equal(redacted.oai_settings.custom_url, 'https://api.example.test/v1');
  assert.equal(redacted.oai_settings.custom_model, 'demo-model');
  assert.equal(redacted.oai_settings.api_key_custom, '[已隐藏]');
  assert.equal(redacted.apiKey, '[已隐藏]');
  assert.equal(redacted.nested[0].token, '[已隐藏]');
  assert.equal(redacted.nested[0].temperature, 0.7);
});
