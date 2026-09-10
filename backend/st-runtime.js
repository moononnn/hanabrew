// 花酿真实测卡运行时桥接：通过无界面 Chromium 连接 SillyTavern 前端。
// 这里故意不复制酒馆逻辑；角色卡、世界书、EJS、MVU 和扩展都由真实 ST 页面执行。

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';

import { findChromiumBinary } from '../lib/browser.js';
import { ensureServer } from '../routes/page-entry.js';
import { paths } from './store.js';
import { updateTheaterProgress } from './theater-progress.js';

const DEFAULT_TIMEOUT_MS = 120000;
const PAGE_READY_TIMEOUT_MS = 30000;
const CDP_COMMAND_TIMEOUT_MS = 30000;
const TEMP_CHAT_PREFIX = 'hanabrew-theater-';
const DUET_CHAT_PREFIX = 'hanabrew-duet-';
const DUET_SESSION_TTL_MS = 30 * 60 * 1000;

function isExecutionContextError(error) {
  return /execution context|context with specified id/i.test(String(error?.message || error));
}

let runQueue = Promise.resolve();
let activeBrowser = null;
const duetSessions = new Map();

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function enqueueRuntimeTask(task) {
  const queued = runQueue.then(task);
  runQueue = queued.catch(() => undefined);
  return queued;
}

function clone(value) {
  if (value === undefined || value === null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function flatten(value, prefix = '', output = {}) {
  if (!isObject(value) || Array.isArray(value)) {
    if (prefix) output[prefix] = value;
    return output;
  }
  const keys = Object.keys(value);
  if (!keys.length && prefix) output[prefix] = value;
  for (const key of keys) {
    const next = prefix ? `${prefix}.${key}` : key;
    flatten(value[key], next, output);
  }
  return output;
}

/**
 * 对 ST/MVU 回传的变量做稳定的深层差异摘要。
 * 不把数值做成模糊描述，真实测卡需要能核对变量前后值。
 */
export function summarizeRuntimeVariableChanges(before, after) {
  const left = flatten(before || {});
  const right = flatten(after || {});
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys]
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .sort()
    .map((key) => ({
      key,
      before: Object.hasOwn(left, key) ? left[key] : null,
      after: Object.hasOwn(right, key) ? right[key] : null,
    }));
}

/**
 * 从 Mvu.getMvuData()、消息变量或扩展 API 的不同包装形态中取出 stat_data。
 * 读不到时返回 null，绝不把“没有读到”伪装成空对象。
 */
export function normalizeRuntimeVariables(value) {
  if (value === undefined || value === null) return null;
  if (isObject(value) && isObject(value.stat_data)) return clone(value.stat_data);
  if (isObject(value) && isObject(value.data?.stat_data)) return clone(value.data.stat_data);
  if (isObject(value) && isObject(value.variables?.stat_data)) return clone(value.variables.stat_data);
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const normalized = normalizeRuntimeVariables(value[index]);
      if (normalized !== null) return normalized;
    }
    return null;
  }
  return isObject(value) ? clone(value) : null;
}

function log(ctx, level, message, extra = undefined) {
  const logger = ctx?.log?.[level] || ctx?.log?.info;
  if (typeof logger !== 'function') return;
  if (extra === undefined) logger.call(ctx.log, `[hanabrew] ${message}`);
  else logger.call(ctx.log, `[hanabrew] ${message}`, extra);
}

function findFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.executionContextId = null;
  }

  async connect(timeoutMs = PAGE_READY_TIMEOUT_MS) {
    if (typeof WebSocket !== 'function') {
      throw new Error('当前 Node 运行时没有 WebSocket，无法连接 SillyTavern 前端调试协议。');
    }
    const socket = new WebSocket(this.webSocketUrl);
    this.socket = socket;
    await new Promise((resolvePromise, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch {}
        reject(new Error('连接 SillyTavern 前端调试协议超时。'));
      }, timeoutMs);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolvePromise();
      };
      socket.addEventListener('open', () => finish());
      socket.addEventListener('error', () => finish(new Error('连接 SillyTavern 前端调试协议失败。')));
    });

    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params?.context;
        if (context && (context.aux?.isDefault || this.executionContextId === null)) {
          this.executionContextId = context.id;
        }
      } else if (message.method === 'Runtime.executionContextsCleared') {
        this.executionContextId = null;
      } else if (message.method === 'Runtime.executionContextDestroyed'
        && message.params?.executionContextId === this.executionContextId) {
        this.executionContextId = null;
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP 命令失败。'));
      else pending.resolve(message.result || {});
    });
    socket.addEventListener('close', () => {
      const error = new Error('SillyTavern 前端调试连接已关闭。');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
    if (!this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error('SillyTavern 前端调试连接尚未建立。'));
    }
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => {
          if (isExecutionContextError(error)) this.executionContextId = null;
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const result = await this.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
          ...(this.executionContextId === null ? {} : { contextId: this.executionContextId }),
        }, Math.max(CDP_COMMAND_TIMEOUT_MS, timeoutMs + 5000));
        if (result.exceptionDetails) {
          const description = result.exceptionDetails.exception?.description
            || result.exceptionDetails.text
            || 'SillyTavern 页面执行失败。';
          throw new Error(description);
        }
        return result.result?.value;
      } catch (error) {
        if (!isExecutionContextError(error)) throw error;
        lastError = error;
        await sleep(100);
      }
    }
    throw lastError || new Error('SillyTavern 页面执行超时。');
  }

  close() {
    try { this.socket?.close(); } catch {}
    this.socket = null;
  }
}

async function waitForCdpTarget(debugPort, expectedUrl, timeoutMs = PAGE_READY_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(1500),
      });
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page'
        && (!expectedUrl || String(target.url || '').startsWith(expectedUrl))
        && target.webSocketDebuggerUrl);
      if (page) return page;
      const fallback = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (fallback && String(fallback.url || '').startsWith(expectedUrl)) return fallback;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`没有找到 SillyTavern 页面调试目标。${lastError ? ` ${lastError.message}` : ''}`);
}

async function waitForCdpExecutionContext(cdp, timeoutMs = PAGE_READY_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression: 'typeof window',
        returnByValue: true,
        ...(cdp.executionContextId === null ? {} : { contextId: cdp.executionContextId }),
      }, 2000);
      if (result.result?.value === 'object') return;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`SillyTavern 页面脚本执行上下文尚未建立。${lastError ? ` ${lastError.message}` : ''}`);
}

async function launchHeadlessBrowser(serverUrl, runId, ctx) {
  const browser = findChromiumBinary();
  if (!browser) {
    throw new Error('真实测卡需要 Chrome、Edge、Brave、Vivaldi 或 Arc；当前电脑没有找到可用的 Chromium 浏览器。');
  }
  const debugPort = await findFreePort();
  const profileDir = join(tmpdir(), `hanabrew-theater-browser-${runId}`);
  mkdirSync(profileDir, { recursive: true });
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI,InfiniteSessionRestore',
    '--window-size=1280,900',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    serverUrl,
  ];

  let processHandle;
  try {
    processHandle = spawn(browser.binary, args, {
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
    throw new Error(`启动无界面 Chromium 失败：${error.message}`);
  }

  let browserOutput = '';
  const collectOutput = (chunk) => {
    browserOutput = `${browserOutput}${String(chunk)}`.slice(-3000);
  };
  processHandle.stdout?.on('data', collectOutput);
  processHandle.stderr?.on('data', collectOutput);

  const exitPromise = new Promise((resolvePromise) => {
    processHandle.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
  const exitCheck = async () => {
    const result = await Promise.race([exitPromise, sleep(200).then(() => null)]);
    if (result) throw new Error(`无界面 Chromium 提前退出（${result.code ?? 'unknown'}）。${browserOutput}`);
  };

  try {
    const target = await (async () => {
      const startedAt = Date.now();
      let lastError = null;
      while (Date.now() - startedAt < PAGE_READY_TIMEOUT_MS) {
        await exitCheck();
        try {
          return await waitForCdpTarget(debugPort, serverUrl, 800);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('无界面 Chromium 页面启动超时。');
    })();
    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await waitForCdpExecutionContext(cdp);
    activeBrowser = { processHandle, cdp, profileDir };
    processHandle.once('exit', () => {
      if (activeBrowser?.processHandle !== processHandle) return;
      try { activeBrowser.cdp?.close(); } catch {}
      activeBrowser = null;
    });
    log(ctx, 'debug', `真实测卡浏览器已连接：${browser.name} / ${serverUrl}`);
    return activeBrowser;
  } catch (error) {
    try { processHandle.kill(); } catch {}
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

async function removeDirectoryWithRetry(directory, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch {
      await sleep(150);
    }
  }
}

async function closeHeadlessBrowser(browser, ctx) {
  if (!browser) return;
  try { browser.cdp?.close(); } catch {}
  try {
    if (browser.processHandle?.pid && process.platform === 'win32') {
      await new Promise((resolvePromise) => {
        const killer = spawn('taskkill', ['/pid', String(browser.processHandle.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('exit', resolvePromise);
        killer.once('error', resolvePromise);
      });
    } else {
      try { browser.processHandle?.kill(); } catch {}
    }
  } catch {}
  try { browser.processHandle?.kill(); } catch {}
  await removeDirectoryWithRetry(browser.profileDir);
  if (activeBrowser === browser) activeBrowser = null;
  log(ctx, 'debug', '真实测卡浏览器已关闭。');
}

function browserRunner(input) {
  const sleepInPage = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  const cloneInPage = (value) => {
    if (value === undefined || value === null) return value ?? null;
    try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
  };
  const publishProgress = (patch = {}) => {
    try {
      const current = window.__hanabrewTheaterProgress || {
        runId: input.runId,
        status: 'running',
        scenes: [],
      };
      window.__hanabrewTheaterProgress = {
        ...current,
        ...patch,
        updatedAt: Date.now(),
      };
    } catch {}
  };
  const isEmptyRecord = (value) => value !== null && typeof value === 'object'
    && !Array.isArray(value) && Object.keys(value).length === 0;
  const hasStatData = (value) => value !== null && typeof value === 'object'
    && value.stat_data && typeof value.stat_data === 'object' && !isEmptyRecord(value.stat_data);
  const normalizeInPage = (value) => {
    if (value === undefined || value === null) return null;
    if (hasStatData(value)) return cloneInPage(value.stat_data);
    if (value && typeof value === 'object' && value.data && hasStatData(value.data)) {
      return cloneInPage(value.data.stat_data);
    }
    if (value && typeof value === 'object' && value.variables && hasStatData(value.variables)) {
      return cloneInPage(value.variables.stat_data);
    }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const found = normalizeInPage(value[index]);
        if (found !== null) return found;
      }
      return null;
    }
    // 空对象/空壳不能冒充有效数据：读不到就返回 null，让上层继续找楼层或消息变量。
    return isEmptyRecord(value) ? null : (value && typeof value === 'object' ? cloneInPage(value) : null);
  };
  const flattenInPage = (value, prefix = '', output = {}) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      if (prefix) output[prefix] = value;
      return output;
    }
    const keys = Object.keys(value);
    if (!keys.length && prefix) output[prefix] = value;
    for (const key of keys) flattenInPage(value[key], prefix ? `${prefix}.${key}` : key, output);
    return output;
  };
  const changesInPage = (before, after) => {
    const left = flattenInPage(before || {});
    const right = flattenInPage(after || {});
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])).map((key) => ({
      key,
      before: Object.hasOwn(left, key) ? left[key] : null,
      after: Object.hasOwn(right, key) ? right[key] : null,
    }));
  };
  const waitForInPage = async (predicate, timeoutMs, message) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return;
      await sleepInPage(100);
    }
    throw new Error(message);
  };
  const readVariables = (ctx) => {
    let liveContext = ctx;
    try {
      const candidate = window.SillyTavern.getContext();
      if (candidate && typeof candidate === 'object') liveContext = candidate;
    } catch {
      // ST 模块刚完成切换时 getContext 可能暂时碰到 TDZ；继续用当前 chat 快照读取。
    }
    let raw = null;
    let source = 'unavailable';
    try {
      if (typeof Mvu !== 'undefined' && typeof Mvu.getMvuData === 'function') {
        raw = Mvu.getMvuData({ type: 'chat' });
        source = 'Mvu.getMvuData';
      }
    } catch {}
    if (raw === null || raw === undefined) {
      try {
        if (typeof Mvu !== 'undefined' && typeof Mvu.getAllVariables === 'function') {
          raw = Mvu.getAllVariables();
          source = 'Mvu.getAllVariables';
        }
      } catch {}
    }
    // Mvu 的 chat 级数据可能是个空壳（没开「更新到聊天变量」时常见）；
    // 空壳不能算读到了，继续向下找消息楼层里的 stat_data。
    let normalized = normalizeInPage(raw);
    if (normalized !== null) return { value: normalized, source };
    const metadataCandidates = [
      [liveContext.chatMetadata?.stat_data, 'chat_metadata.stat_data'],
      [liveContext.chatMetadata?.variables, 'chat_metadata.variables'],
    ];
    for (const [candidate, candidateSource] of metadataCandidates) {
      normalized = normalizeInPage(candidate);
      if (normalized !== null) return { value: normalized, source: candidateSource };
    }
    // MagVarUpdate 是楼层式存储：stat_data 按消息（楼层）落盘，最近楼层可能带多条历史。
    // 从最新消息往前找第一条带非空 stat_data 的消息，取它的 variables。
    for (let index = (liveContext.chat?.length || 0) - 1; index >= 0; index -= 1) {
      const candidate = normalizeInPage(liveContext.chat[index]?.variables);
      if (candidate !== null) return { value: candidate, source: 'chat.message.variables' };
    }
    return { value: null, source };
  };
  const waitForStableVariables = async (ctx, timeoutMs = 2000) => {
    const hasMvuProvider = typeof Mvu !== 'undefined'
      && (typeof Mvu.getMvuData === 'function' || typeof Mvu.getAllVariables === 'function');
    let state = readVariables(ctx);
    if (!hasMvuProvider || state.value !== null) return state;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await sleepInPage(100);
      state = readVariables(ctx);
      if (state.value !== null) return state;
    }
    return state;
  };
  const latestAssistantMessage = (ctx) => {
    for (let index = (ctx.chat?.length || 0) - 1; index >= 0; index -= 1) {
      const message = ctx.chat[index];
      if (message && !message.is_user && !message.is_system) return message;
    }
    return null;
  };
  const sendTurn = async (ctx, text, timeoutMs) => {
    const textarea = document.querySelector('#send_textarea');
    if (!textarea) throw new Error('SillyTavern 页面没有找到消息输入框。');
    const beforeLength = ctx.chat?.length || 0;
    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await ctx.generate('normal');
    await waitForInPage(
      () => (ctx.chat?.length || 0) > beforeLength && Boolean(latestAssistantMessage(ctx)?.mes),
      timeoutMs,
      '等待 SillyTavern 生成回复超时。',
    );
    return latestAssistantMessage(ctx);
  };

  const getRuntimeContext = async () => {
    await waitForInPage(
      () => Boolean(window.SillyTavern && typeof window.SillyTavern.getContext === 'function'),
      input.timeoutMs,
      'SillyTavern 前端运行时尚未就绪，无法进行真实测卡。',
    );
    const context = window.SillyTavern.getContext();
    await waitForInPage(
      () => Array.isArray(context.characters) && context.characters.length > 0,
      input.timeoutMs,
      '等待 SillyTavern 角色列表就绪超时。',
    );
    return context;
  };
  const findCharacterIndex = (context) => {
    const wantedName = String(input.characterName || '').trim();
    const wantedId = String(input.characterId || '').trim();
    return context.characters.findIndex((character) => (
      (wantedName && String(character?.name || '').trim() === wantedName)
      || (wantedId && String(character?.avatar || '').trim() === wantedId)
      || (wantedId && String(character?.id || '').trim() === wantedId)
    ));
  };
  const normalizeChatName = (value) => String(value || '').trim().replace(/\.jsonl$/i, '');
  const ensureRequestedChat = async (context, characterIndex, chatFile, forceOpen = false) => {
    const expectedChat = normalizeChatName(chatFile);
    const currentChat = normalizeChatName(context.chatId || context.chatFile || '');
    const currentCharacter = String(context.characterId ?? '').trim();
    const characterMatches = !currentCharacter || currentCharacter === String(characterIndex);
    const chatMatches = !currentChat || currentChat === expectedChat;
    if (forceOpen || !characterMatches || !chatMatches) {
      await context.selectCharacterById(characterIndex, { switchMenu: false });
      await context.openCharacterChat(chatFile);
      await sleepInPage(500);
    }
    return window.SillyTavern.getContext();
  };
  const yueAssistantLoaded = () => Boolean(
    document.getElementById('tavernai-toggle-btn')
    || document.getElementById('tavernai-fab-btn')
    || document.getElementById('tavernai-panel'),
  );

  if (['duet-start', 'duet-resume', 'duet-turn'].includes(input.action)) {
    return (async () => {
      const actionTimeout = Number(input.timeoutMs) || 120000;
      const context = await getRuntimeContext();
      const characterIndex = findCharacterIndex(context);
      const wantedName = String(input.characterName || '').trim();
      const wantedId = String(input.characterId || '').trim();
      if (characterIndex < 0) throw new Error(`SillyTavern 里没有找到角色卡“${wantedName || wantedId}”。`);
      const chatFile = String(input.chatFile || '').trim();
      if (!chatFile) throw new Error('代笔对戏缺少隔离聊天标识。');
      const chatContext = await ensureRequestedChat(
        context,
        characterIndex,
        chatFile,
        input.action !== 'duet-turn',
      );
      const character = {
        name: String(chatContext.characters[characterIndex]?.name || wantedName),
        index: characterIndex,
      };
      if (input.action !== 'duet-turn') {
        const openingMessage = chatContext.chat?.find((message) => message && !message.is_user && !message.is_system);
        const opening = String(openingMessage?.mes || '');
        const initialState = await waitForStableVariables(chatContext);
        return {
          action: input.action,
          character,
          opening,
          initialVariables: initialState.value,
          initialVariableSource: initialState.source,
          finalVariables: null,
          finalVariableSource: 'unavailable',
          mvuAvailable: typeof Mvu !== 'undefined',
          yueAssistantLoaded: yueAssistantLoaded(),
          chatFile,
        };
      }
      const user = String(input.text || '').trim();
      if (!user) throw new Error('代笔对戏这一轮没有可发送的玩家台词。');
      const sceneIndex = Math.max(1, Number(input.sceneIndex) || 1);
      const beforeState = await waitForStableVariables(chatContext);
      const replyMessage = await sendTurn(chatContext, user, actionTimeout);
      await sleepInPage(250);
      const afterState = await waitForStableVariables(chatContext);
      const before = beforeState.value;
      const after = afterState.value;
      return {
        action: input.action,
        character,
        chatFile,
        mvuAvailable: typeof Mvu !== 'undefined',
        yueAssistantLoaded: yueAssistantLoaded(),
        finalVariables: after,
        finalVariableSource: afterState.source,
        scene: {
          index: sceneIndex,
          user,
          reply: String(replyMessage?.mes || ''),
          variableSource: afterState.source,
          variablesBefore: before,
          variablesAfter: after,
          variableChanges: before === null || after === null ? [] : changesInPage(before, after),
        },
      };
    })();
  }

  return (async () => {
    publishProgress({ status: 'running', scenes: [], activeScene: null });
    try {
      await waitForInPage(
      () => Boolean(window.SillyTavern && typeof window.SillyTavern.getContext === 'function'),
      input.timeoutMs,
      'SillyTavern 前端运行时尚未就绪，无法进行真实测卡。',
    );
    const context = window.SillyTavern.getContext();
    await waitForInPage(
      () => Array.isArray(context.characters) && context.characters.length > 0,
      input.timeoutMs,
      '等待 SillyTavern 角色列表就绪超时。',
    );
    const wantedName = String(input.characterName || '').trim();
    const wantedId = String(input.characterId || '').trim();
    const characterIndex = context.characters.findIndex((character) => (
      (wantedName && String(character?.name || '').trim() === wantedName)
      || (wantedId && String(character?.avatar || '').trim() === wantedId)
      || (wantedId && String(character?.id || '').trim() === wantedId)
    ));
    if (characterIndex < 0) throw new Error(`SillyTavern 里没有找到角色卡“${wantedName || wantedId}”。`);

    await context.selectCharacterById(characterIndex, { switchMenu: false });
    const chatFile = `hanabrew-theater-${input.runId}`;
    await context.openCharacterChat(chatFile);
    await sleepInPage(500);

      const openingMessage = context.chat?.find((message) => message && !message.is_user && !message.is_system);
      const opening = String(openingMessage?.mes || '');
      const initialState = await waitForStableVariables(context);
      const scenes = [];
      publishProgress({
        opening,
        initialVariables: initialState.value,
        initialVariableSource: initialState.source,
        mvuAvailable: typeof Mvu !== 'undefined',
      });
      for (let index = 0; index < input.turns.length; index += 1) {
        const user = String(input.turns[index] || '').trim();
        publishProgress({
          activeScene: { index: index + 1, user },
          currentTurnIndex: index,
        });
        const beforeState = await waitForStableVariables(context);
        const replyMessage = await sendTurn(context, user, input.timeoutMs);
        await sleepInPage(250);
        const afterState = await waitForStableVariables(context);
        const before = beforeState.value;
        const after = afterState.value;
        scenes.push({
          index: index + 1,
          user,
          reply: String(replyMessage?.mes || ''),
          variableSource: afterState.source,
          variablesBefore: before,
          variablesAfter: after,
          variableChanges: before === null || after === null ? [] : changesInPage(before, after),
        });
        publishProgress({
          activeScene: null,
          currentTurnIndex: index + 1,
          scenes: scenes.slice(),
        });
      }
      const finalState = await waitForStableVariables(context);
      const result = {
        character: { name: String(context.characters[characterIndex]?.name || wantedName), index: characterIndex },
        opening,
        initialVariables: initialState.value,
        initialVariableSource: initialState.source,
        finalVariables: finalState.value,
        finalVariableSource: finalState.source,
        mvuAvailable: typeof Mvu !== 'undefined',
        yueAssistantLoaded: Boolean(
          document.getElementById('tavernai-toggle-btn')
          || document.getElementById('tavernai-fab-btn')
          || document.getElementById('tavernai-panel'),
        ),
        chatFile,
        scenes,
      };
      publishProgress({
        status: 'done',
        activeScene: null,
        currentTurnIndex: scenes.length,
        finalVariables: finalState.value,
        finalVariableSource: finalState.source,
        scenes: scenes.slice(),
      });
      return result;
    } catch (error) {
      publishProgress({ status: 'error', activeScene: null, error: String(error?.message || error) });
      throw error;
    }
  })();
}

function cleanupTemporaryChat(ctx, characterName, runId, prefixBase = TEMP_CHAT_PREFIX) {
  const root = resolve(paths(ctx).chats);
  const prefix = runId ? `${prefixBase}${runId}` : prefixBase;
  let folders;
  try {
    folders = [root, ...readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(root, entry.name))];
  } catch {
    return 0;
  }
  // ST 的聊天目录在不同版本/导入路径下可能用角色名、头像名、角色 ID，
  // 也可能直接平铺在 chats 根目录；因此只按唯一临时前缀扫描，不依赖 characterName 猜路径。
  let removed = 0;
  for (const folder of folders) {
    if (!folder.startsWith(`${root}${sep}`)) continue;
    let names;
    try { names = readdirSync(folder); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.jsonl')) continue;
      const file = resolve(folder, name);
      if (file.startsWith(`${folder}${sep}`)) {
        try { rmSync(file, { force: true }); removed += 1; } catch {}
      }
    }
  }
  return removed;
}

async function cleanupTemporaryChatEventually(ctx, characterName, runId, prefixBase = TEMP_CHAT_PREFIX) {
  let removed = 0;
  // ST 的 saveChatConditional 可能在最后一条回复之后再落盘一次；多轮短暂复查，
  // 避免“清理发生得太早”留下本次刚生成的临时聊天。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    removed += cleanupTemporaryChat(ctx, characterName, runId, prefixBase);
    if (attempt < 11) await sleep(150);
  }
  return removed;
}

function cleanupAllTemporaryChats(ctx, prefixBase = TEMP_CHAT_PREFIX) {
  return cleanupTemporaryChat(ctx, '', null, prefixBase);
}

function startRuntimeProgressPolling(cdp, runId, onProgress) {
  if (typeof onProgress !== 'function') return async () => {};
  let stopped = false;
  let lastSnapshot = '';
  const loop = (async () => {
    while (!stopped) {
      try {
        const snapshot = await cdp.evaluate(
          `(() => { const progress = window.__hanabrewTheaterProgress; return progress && progress.runId === ${JSON.stringify(runId)} ? progress : null; })()`,
          2000,
        );
        const serialized = JSON.stringify(snapshot || null);
        if (snapshot && serialized !== lastSnapshot) {
          lastSnapshot = serialized;
          await onProgress(snapshot);
        }
      } catch {
        // 测试页面正在切换上下文或即将关闭时，主测卡结果仍是最终事实。
      }
      if (!stopped) await sleep(180);
    }
  })();
  return async () => {
    stopped = true;
    await loop.catch(() => {});
  };
}

async function runSillyTavernTheaterOnce({ characterId, characterName, turns, timeoutMs, runId, onProgress }, ctx = {}) {
  if (ctx.theaterRuntime?.run) {
    const injected = await ctx.theaterRuntime.run({ characterId, characterName, turns, timeoutMs, runId, onProgress });
    return { ...injected, engine: 'sillytavern-runtime', isolated: true };
  }
  const serverUrl = await ensureServer(ctx);
  const browser = await launchHeadlessBrowser(serverUrl, runId, ctx);
  try {
    const expression = `(${browserRunner.toString()})(${JSON.stringify({
      characterId,
      characterName,
      turns,
      timeoutMs,
      runId,
    })})`;
    const stopProgressPolling = startRuntimeProgressPolling(browser.cdp, runId, onProgress);
    try {
      const result = await browser.cdp.evaluate(expression, timeoutMs * Math.max(2, turns.length + 1));
      return {
        ...result,
        engine: 'sillytavern-runtime',
        isolated: true,
        serverUrl,
        chatFile: result?.chatFile || `${TEMP_CHAT_PREFIX}${runId}.jsonl`,
      };
    } finally {
      await stopProgressPolling();
    }
  } finally {
    await closeHeadlessBrowser(browser, ctx);
  }
}

/**
 * 在真实 SillyTavern 前端中跑隔离小剧场。
 * 同一时间只允许一个运行，避免两个无界面页面同时切换 ST 角色状态。
 */
export async function runSillyTavernTheater({ characterId, characterName, turns, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress }, ctx = {}) {
  await purgeExpiredDuetSessions(ctx);
  if (duetSessions.size) throw new Error('有一场代笔对戏正在进行，请先结束它再做变量体检。');
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const task = enqueueRuntimeTask(async () => {
    await purgeExpiredDuetSessions(ctx);
    if (duetSessions.size) throw new Error('有一场代笔对戏正在进行，请先结束它再做变量体检。');
    const staleRemoved = cleanupAllTemporaryChats(ctx);
    if (staleRemoved) log(ctx, 'warn', `已清理上次中断留下的真实测卡临时聊天：${staleRemoved} 个文件。`);
    try {
      const result = await runSillyTavernTheaterOnce({
        characterId,
        characterName,
        turns,
        timeoutMs,
        runId,
        onProgress,
      }, ctx);
      if (typeof onProgress === 'function') {
        try {
          await onProgress({ ...result, status: 'done', activeScene: null });
        } catch {}
      }
      return { ...result, runId };
    } finally {
      const removed = await cleanupTemporaryChatEventually(ctx, characterName, runId);
      const lateRemoved = cleanupAllTemporaryChats(ctx);
      const totalRemoved = removed + lateRemoved;
      if (totalRemoved) log(ctx, 'debug', `已清理真实测卡临时聊天：${totalRemoved} 个文件。`);
    }
  });
  return task;
}

function pageActionExpression(input) {
  return `(${browserRunner.toString()})(${JSON.stringify(input)})`;
}

async function evaluatePageAction(browser, input, timeoutMs) {
  return browser.cdp.evaluate(
    pageActionExpression(input),
    Math.max(CDP_COMMAND_TIMEOUT_MS, (Number(timeoutMs) || DEFAULT_TIMEOUT_MS) * 2),
  );
}

function browserIsAlive(browser) {
  return Boolean(
    browser?.processHandle
    && browser.processHandle.exitCode == null
    && browser?.cdp?.socket?.readyState === 1,
  );
}

async function disposeDuetSession(session, ctx = {}) {
  if (!session) return 0;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  try { await closeHeadlessBrowser(session.browser, ctx); } catch {}
  return cleanupTemporaryChatEventually(ctx, session.characterName, session.duetId, DUET_CHAT_PREFIX);
}

function scheduleDuetExpiry(session, ctx = {}) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    const current = duetSessions.get(session.duetId);
    if (current !== session) return;
    if (Date.now() - session.lastActiveAt < DUET_SESSION_TTL_MS) {
      scheduleDuetExpiry(session, ctx);
      return;
    }
    duetSessions.delete(session.duetId);
    updateTheaterProgress(session.duetId, {
      status: 'error',
      activeScene: null,
      error: '对戏因闲置超时已结束，请重新开始。',
    });
    void disposeDuetSession(session, ctx)
      .then((removed) => {
        if (removed) log(ctx, 'debug', `代笔对戏闲置超时，已清理临时聊天：${removed} 个文件。`);
      })
      .catch((error) => log(ctx, 'warn', `代笔对戏超时清理失败：${error.message}`));
  }, DUET_SESSION_TTL_MS + 100);
  session.idleTimer.unref?.();
}

async function purgeExpiredDuetSessions(ctx = {}) {
  const now = Date.now();
  for (const [duetId, session] of duetSessions) {
    if (now - session.lastActiveAt <= DUET_SESSION_TTL_MS) continue;
    duetSessions.delete(duetId);
    const removed = await disposeDuetSession(session, ctx);
    if (removed) log(ctx, 'debug', `已清理超时的代笔对戏临时聊天：${removed} 个文件。`);
  }
}

async function ensureDuetBrowser(session, ctx = {}) {
  if (browserIsAlive(session.browser)) return session.browser;
  try { await closeHeadlessBrowser(session.browser, ctx); } catch {}
  const browser = await launchHeadlessBrowser(session.serverUrl, session.duetId, ctx);
  try {
    await evaluatePageAction(browser, {
      action: 'duet-resume',
      characterId: session.characterId,
      characterName: session.characterName,
      chatFile: session.chatFile,
      timeoutMs: session.timeoutMs,
    }, session.timeoutMs);
  } catch (error) {
    await closeHeadlessBrowser(browser, ctx);
    throw error;
  }
  session.browser = browser;
  return browser;
}

/**
 * 启动一场驻留的真实 SillyTavern 代笔对戏。
 * 浏览器和临时聊天会在后续逐轮调用之间保留，直到明确结束或超时清理。
 */
export async function startSillyTavernDuet({
  duetId,
  characterId,
  characterName,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}, ctx = {}) {
  const id = String(duetId || '').trim();
  if (!id) throw new Error('代笔对戏缺少会话标识。');
  if (ctx.duetRuntime?.start) {
    const injected = await ctx.duetRuntime.start({ id, characterId, characterName, timeoutMs });
    return {
      ...injected,
      duetId: id,
      chatFile: injected.chatFile || `${DUET_CHAT_PREFIX}${id}`,
      engine: 'sillytavern-runtime',
      isolated: true,
    };
  }
  const task = enqueueRuntimeTask(async () => {
    await purgeExpiredDuetSessions(ctx);
    if (duetSessions.size) throw new Error('已有一场代笔对戏正在进行，请先结束它。');
    const staleRemoved = cleanupAllTemporaryChats(ctx, DUET_CHAT_PREFIX);
    if (staleRemoved) log(ctx, 'warn', `已清理上次中断留下的代笔对戏临时聊天：${staleRemoved} 个文件。`);
    const serverUrl = await ensureServer(ctx);
    const chatFile = `${DUET_CHAT_PREFIX}${id}`;
    const browser = await launchHeadlessBrowser(serverUrl, id, ctx);
    try {
      const result = await evaluatePageAction(browser, {
        action: 'duet-start',
        characterId,
        characterName,
        chatFile,
        timeoutMs,
      }, timeoutMs);
      const session = {
        duetId: id,
        characterId,
        characterName,
        timeoutMs,
        chatFile,
        serverUrl,
        browser,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      duetSessions.set(id, session);
      scheduleDuetExpiry(session, ctx);
      return {
        ...result,
        duetId: id,
        engine: 'sillytavern-runtime',
        isolated: true,
        serverUrl,
        chatFile,
      };
    } catch (error) {
      await closeHeadlessBrowser(browser, ctx);
      await cleanupTemporaryChatEventually(ctx, characterName, id, DUET_CHAT_PREFIX);
      throw error;
    }
  });
  return task;
}

/** 让驻留的真实酒馆会话只推进一轮。playerMessage 会原样作为玩家消息发送。 */
export async function runSillyTavernDuetTurn({
  duetId,
  playerMessage,
  sceneIndex = 1,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}, ctx = {}) {
  const id = String(duetId || '').trim();
  const text = String(playerMessage || '').trim();
  if (!id) throw new Error('代笔对戏缺少会话标识。');
  if (!text) throw new Error('代笔对戏这一轮没有可发送的玩家台词。');
  if (ctx.duetRuntime?.turn) {
    const injected = await ctx.duetRuntime.turn({
      id,
      playerMessage: text,
      sceneIndex,
      timeoutMs,
    });
    return { ...injected, duetId: id, engine: 'sillytavern-runtime', isolated: true };
  }
  const task = enqueueRuntimeTask(async () => {
    await purgeExpiredDuetSessions(ctx);
    const session = duetSessions.get(id);
    if (!session) throw new Error('代笔对戏会话已结束或已失效，请重新从小剧场开始。');
    session.lastActiveAt = Date.now();
    scheduleDuetExpiry(session, ctx);
    const browser = await ensureDuetBrowser(session, ctx);
    const result = await evaluatePageAction(browser, {
      action: 'duet-turn',
      characterId: session.characterId,
      characterName: session.characterName,
      chatFile: session.chatFile,
      text,
      sceneIndex,
      timeoutMs: session.timeoutMs,
    }, timeoutMs || session.timeoutMs);
    session.lastActiveAt = Date.now();
    scheduleDuetExpiry(session, ctx);
    return {
      ...result,
      duetId: id,
      engine: 'sillytavern-runtime',
      isolated: true,
      chatFile: session.chatFile,
    };
  });
  return task;
}

/** 结束代笔对戏并清理它创建的临时聊天，不碰正式聊天。 */
export async function endSillyTavernDuet({ duetId }, ctx = {}) {
  const id = String(duetId || '').trim();
  if (!id) throw new Error('结束代笔对戏缺少会话标识。');
  if (ctx.duetRuntime?.end) {
    const injected = await ctx.duetRuntime.end({ id });
    return { ...injected, duetId: id, engine: 'sillytavern-runtime', isolated: true };
  }
  const task = enqueueRuntimeTask(async () => {
    await purgeExpiredDuetSessions(ctx);
    const session = duetSessions.get(id);
    if (!session) {
      const removed = await cleanupTemporaryChatEventually(ctx, '', id, DUET_CHAT_PREFIX);
      return {
        duetId: id,
        ended: true,
        alreadyEnded: true,
        cleanedChats: removed,
        engine: 'sillytavern-runtime',
        isolated: true,
      };
    }
    duetSessions.delete(id);
    const removed = await disposeDuetSession(session, ctx);
    return {
      duetId: id,
      ended: true,
      alreadyEnded: false,
      cleanedChats: removed,
      engine: 'sillytavern-runtime',
      isolated: true,
    };
  });
  return task;
}

export async function stopSillyTavernTheater(ctx = {}) {
  const browser = activeBrowser;
  activeBrowser = null;
  if (browser) {
    try { await closeHeadlessBrowser(browser, ctx); } catch {}
  }
  const sessions = [...duetSessions.values()];
  duetSessions.clear();
  for (const session of sessions) {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.browser !== browser) {
      try { await closeHeadlessBrowser(session.browser, ctx); } catch {}
    }
    try { await cleanupTemporaryChatEventually(ctx, session.characterName, session.duetId, DUET_CHAT_PREFIX); } catch {}
  }
}

export const runtimeDefaults = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  temporaryChatPrefix: TEMP_CHAT_PREFIX,
  duetChatPrefix: DUET_CHAT_PREFIX,
};
