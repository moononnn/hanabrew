/**
 * 花酿 LLM — LLM 调用封装
 * 提供统一的 LLM 调用接口，供 API 路由和 Agent 工具共用
 */

/**
 * 调用 LLM 完成对话
 * @param {object} params
 * @param {Array} params.messages - OpenAI 格式的消息数组
 * @param {string} params.characterName - 角色名（用于日志）
 * @param {object} ctx - 插件上下文
 * @returns {object} { text, usage }
 */
export async function callLLM({ messages, characterName }, ctx = {}) {
  const { readSettings, readSecrets } = await import('./store.js');
  const settings = await readSettings(ctx);

  // 优先读 UI 配的 custom 通道（MiniMax），回退到顶层 apiUrl/apiKey/model（旧式配置）
  const oai = settings.oai_settings || {};
  const customUrl = String(oai.custom_url || '').trim();
  const customModel = String(oai.custom_model || '').trim();
  let apiUrl = '';
  let apiKey = '';
  let model = '';
  if (customUrl && customModel) {
    apiUrl = customUrl.replace(/\/+$/, '');
    model = customModel;
    const secrets = await readSecrets(ctx);
    const customKeys = secrets.api_key_custom || secrets.api_key_minimax || [];
    apiKey = (Array.isArray(customKeys) ? customKeys.find((k) => k?.active)?.value : customKeys) || '';
  }
  if (!apiKey) {
    apiUrl = (settings.apiUrl || settings.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
    apiKey = settings.apiKey || '';
    model = settings.model || 'deepseek-ai/DeepSeek-V3';
  }

  if (!apiKey) {
    throw new Error('未配置 API Key。请在花酿设置中填写。');
  }

  const body = {
    model,
    messages,
    temperature: settings.temperature ?? 0.7,
    max_tokens: settings.maxTokens ?? 1024,
    stream: false,
  };

  ctx.log?.info?.(`[hanabrew] LLM call: model=${model}, char=${characterName}, msgs=${messages.length}`);

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`LLM API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};

  ctx.log?.info?.(`[hanabrew] LLM response: tokens=${usage.total_tokens || '?'}`);

  return { text, usage };
}
