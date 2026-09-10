// 小剧场测卡过程状态：卡片只展示运行证据，结论仍回到主对话。

const RUN_TTL_MS = 30 * 60 * 1000;
const DUET_RUN_TTL_MS = 2 * 60 * 60 * 1000;

const DUET_PACE_DEFINITIONS = Object.freeze({
  free: Object.freeze({
    id: 'free',
    label: '自由发展',
    autoContinue: true,
    maxAutoRounds: 6,
    pausePolicy: '只在重大剧情、不可逆选择或明确边界节点暂停',
  }),
  slow: Object.freeze({
    id: 'slow',
    label: '慢慢推进',
    autoContinue: true,
    maxAutoRounds: 4,
    pausePolicy: '普通回合连续推进，关键剧情、关系变化、越界或重大时间跳跃时暂停',
  }),
  restrained: Object.freeze({
    id: 'restrained',
    label: '保持克制',
    autoContinue: false,
    maxAutoRounds: 1,
    pausePolicy: '每轮保留方向控制，出现暧昧、冲突或边界变化前暂停',
  }),
});

const DUET_PACE_BY_LABEL = Object.freeze(Object.fromEntries(
  Object.values(DUET_PACE_DEFINITIONS).map((pace) => [pace.label, pace.id]),
));

const runs = new Map();
const pendingBySession = new Map();
const bindings = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  const result = String(value ?? '').trim();
  return result || '';
}

function makeRunId() {
  return `theater-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function resolveDuetPace(value) {
  const raw = text(value);
  const id = Object.hasOwn(DUET_PACE_DEFINITIONS, raw)
    ? raw
    : (Object.hasOwn(DUET_PACE_BY_LABEL, raw) ? DUET_PACE_BY_LABEL[raw] : 'free');
  return clone(DUET_PACE_DEFINITIONS[id]);
}

function sessionKeys(input = {}) {
  const keys = [];
  for (const field of ['sessionPath', 'sessionId', 'sessionRef']) {
    const value = input[field];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const normalized = text(value);
    if (normalized) keys.push(`${field}:${normalized}`);
  }
  return [...new Set(keys)];
}

function removePendingRun(runId) {
  for (const [key, pendingRunIds] of pendingBySession) {
    const remaining = pendingRunIds.filter((pendingRunId) => pendingRunId !== runId);
    if (remaining.length) pendingBySession.set(key, remaining);
    else pendingBySession.delete(key);
  }
}

function purgeExpired() {
  const now = Date.now();
  for (const [runId, run] of runs) {
    const runCutoff = now - (run.mode === 'duet' ? DUET_RUN_TTL_MS : RUN_TTL_MS);
    if (run.updatedAt >= runCutoff) continue;
    runs.delete(runId);
    bindings.delete(runId);
    removePendingRun(runId);
  }
}

export function createTheaterProgress(input = {}) {
  purgeExpired();
  const now = Date.now();
  const mode = text(input.mode) || (text(input.testType) === 'duet' ? 'duet' : 'scripted');
  const pace = mode === 'duet' ? resolveDuetPace(input.pace || input.detail) : null;
  const run = {
    runId: makeRunId(),
    mode,
    status: mode === 'duet' ? 'waiting_for_direction' : 'waiting',
    createdAt: now,
    updatedAt: now,
    characterId: text(input.characterId),
    characterName: text(input.characterName),
    testType: text(input.testType),
    detail: text(input.detail),
    pace: pace?.id || '',
    paceLabel: pace?.label || '',
    autoContinue: pace?.autoContinue === true,
    maxAutoRounds: Number(pace?.maxAutoRounds || 0),
    autoRoundsSinceCheckpoint: 0,
    needsUserCheckpoint: false,
    pausePolicy: pace?.pausePolicy || '',
    turns: [],
    currentTurnIndex: 0,
    activeScene: null,
    opening: '',
    scenes: [],
    initialVariables: null,
    finalVariables: null,
    initialVariableSource: 'unavailable',
    finalVariableSource: 'unavailable',
    mvuAvailable: null,
    isolated: false,
    warnings: [],
    error: null,
  };
  runs.set(run.runId, run);
  bindings.set(run.runId, sessionKeys(input));
  for (const key of sessionKeys(input)) {
    const pendingRunIds = pendingBySession.get(key) || [];
    pendingRunIds.push(run.runId);
    pendingBySession.set(key, pendingRunIds);
  }
  return clone(run);
}

export function claimTheaterProgress(input = {}) {
  purgeExpired();
  const candidates = [...new Set(sessionKeys(input)
    .flatMap((key) => pendingBySession.get(key) || []))]
    .map((runId) => runs.get(runId))
    .filter((run) => run && ['waiting', 'waiting_for_direction'].includes(run.status))
    .filter((run) => !input.characterId || !run.characterId || run.characterId === text(input.characterId))
    .filter((run) => !input.mode || run.mode === text(input.mode))
    .filter((run) => !(run.mode === 'duet' && run.chatFile))
    // 主对话按收到 handoff 的先后消费请求；同一会话多次提交时保持 FIFO，避免串到后一张卡。
    .sort((left, right) => left.createdAt - right.createdAt);
  const run = candidates[0];
  if (!run) return null;
  run.status = 'running';
  run.claimedAt = Date.now();
  run.updatedAt = run.claimedAt;
  removePendingRun(run.runId);
  return clone(run);
}

export function getTheaterProgress(runId) {
  purgeExpired();
  const run = runs.get(text(runId));
  return run ? clone(run) : null;
}

export function getTheaterProgressForSession(runId, input = {}) {
  purgeExpired();
  const id = text(runId);
  const run = runs.get(id);
  const allowedKeys = bindings.get(id) || [];
  const requestedKeys = sessionKeys(input);
  if (!run || !allowedKeys.length || !requestedKeys.some((key) => allowedKeys.includes(key))) return null;
  return clone(run);
}

export function updateTheaterProgress(runId, patch = {}) {
  purgeExpired();
  const run = runs.get(text(runId));
  if (!run) return null;
  Object.assign(run, patch, { updatedAt: Date.now() });
  return clone(run);
}

export function completeTheaterProgress(runId, patch = {}) {
  return updateTheaterProgress(runId, {
    ...patch,
    status: 'done',
    activeScene: null,
  });
}

export function failTheaterProgress(runId, error) {
  return updateTheaterProgress(runId, {
    status: 'error',
    activeScene: null,
    error: text(error) || '真实测卡失败。',
  });
}

export function discardTheaterProgress(runId) {
  const id = text(runId);
  if (!id) return false;
  const existed = runs.delete(id);
  bindings.delete(id);
  removePendingRun(id);
  return existed;
}

export const theaterProgressDefaults = {
  runTtlMs: RUN_TTL_MS,
  duetRunTtlMs: DUET_RUN_TTL_MS,
};
