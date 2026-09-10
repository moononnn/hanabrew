// 花酿「小剧场」卡片：先选择测卡目标，提交后展示真实测卡过程。
import { listCharacters } from '../backend/characters.js';
import { readState } from '../backend/store.js';
import { endTheaterDuet } from '../backend/theater.js';
import {
  createTheaterProgress,
  discardTheaterProgress,
  getTheaterProgress,
  getTheaterProgressForSession,
} from '../backend/theater-progress.js';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function safeJson(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function theaterClientScript({ characters, initialCharacterId, initialProgress, initialRunId, canHandoff = true }) {
  return `(function () {
  'use strict';
  var characters = ${safeJson(characters)};
  var selectedCharacter = ${safeJson(initialCharacterId)};
  var selectedTest = 'mvu';
  var selectedDetail = '';
  var activeProgress = ${safeJson(initialProgress)};
  var initialRunId = ${safeJson(initialRunId)};
  var canHandoff = ${safeJson(canHandoff)};
  var pollTimer = null;
  var pollFailures = 0;
  var pollInFlight = false;
  var waitingSince = 0;
  var WAITING_TIMEOUT_MS = 5 * 60 * 1000;
  var tests = {
    mvu: { label: '选择要检查的变量', items: [] },
    duet: { label: '选择推进节奏', items: [['自由发展', '普通回合自动继续，重大剧情才停下来问你'], ['慢慢推进', '节奏放缓但连续推进，关键剧情才停下来问你'], ['保持克制', '每轮保留方向控制，敏感变化前先停下来']] },
    persona: { label: '选择人设测试方向', items: [['日常回应', '检查普通聊天中的语气与行为'], ['情绪波动', '检查压力或安慰场景'], ['原则冲突', '检查核心设定是否稳定']] },
    opening: { label: '选择开场测试方向', items: [['初次见面', '检查开场白与第一句回应'], ['续接开场', '检查开场情境能否自然延续']] },
    worldbook: { label: '选择世界书测试方向', items: [['关键词触发', '检查相关设定是否出现'], ['设定冲突', '检查多条设定同时出现时的优先级']] },
    scene: { label: '选择场景测试方向', items: [['关系推进', '检查事件后的态度变化'], ['冲突处理', '检查矛盾升级与收束'], ['日常互动', '检查场景细节和连续性']] },
    boundary: { label: '选择边界测试方向', items: [['拒绝请求', '检查角色拒绝是否符合人设'], ['异常输入', '检查突然转向时能否稳住'], ['沉默冷场', '检查角色如何处理停顿']] }
  };

  function $(id) { return document.getElementById(id); }
  function escapeText(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function formatText(value) { return escapeText(value).replace(/\\r?\\n/g, '<br>'); }
  function setSelected(selector, attr, value) {
    document.querySelectorAll(selector).forEach(function (el) {
      el.classList.toggle('selected', el.getAttribute(attr) === value);
    });
  }
  function currentCharacter() {
    return characters.find(function (character) { return character.id === selectedCharacter; }) || characters[0];
  }
  function pluginBase() {
    var marker = '/api/plugins/';
    var at = location.pathname.indexOf(marker);
    if (at < 0) return location.origin + marker + 'hanabrew';
    var rest = location.pathname.slice(at + marker.length);
    var slash = rest.indexOf('/');
    return location.origin + marker + (slash < 0 ? rest : rest.slice(0, slash));
  }
  function authHeaders() {
    var headers = {};
    var surface = new URLSearchParams(location.search).get('pluginSurfaceSession');
    if (surface) headers['X-Hana-Plugin-Surface-Session'] = surface;
    return headers;
  }
  function renderDetails() {
    var config = tests[selectedTest];
    var items = config.items.slice();
    if (selectedTest === 'mvu') {
      items = (currentCharacter() && currentCharacter().variables) || [];
      if (!items.length) items = [['运行时变量', '会从真实 ST 临时聊天读取 stat_data']];
    }
    $('detail-label').textContent = '3 · ' + config.label;
    $('details').innerHTML = items.map(function (item) {
      var value = Array.isArray(item) ? item[0] : item;
      var note = Array.isArray(item) ? '<small>' + escapeText(item[1]) + '</small>' : '';
      return '<button type="button" class="choice" data-detail="' + escapeText(value) + '"><span>' + escapeText(value) + '</span>' + note + '</button>';
    }).join('');
    selectedDetail = items[0] ? (Array.isArray(items[0]) ? items[0][0] : items[0]) : '';
    setSelected('[data-detail]', 'data-detail', selectedDetail);
    if ($('handoff') && canHandoff) $('handoff').textContent = selectedTest === 'duet' ? '发给小花开始对戏' : '发给小花开始测试';
  }
  function showStatus(message, isError) {
    var status = $('status');
    status.textContent = message || '';
    status.className = 'status' + (isError ? ' error' : '');
  }
  function valueText(value) {
    if (value === null || value === undefined) return '未读取';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    }
    return String(value);
  }
  function duetPaceLabel(progress) {
    return String((progress && (progress.paceLabel || progress.detail)) || '').trim();
  }
  function duetNeedsCheckpoint(progress) {
    return Boolean(progress && progress.needsUserCheckpoint);
  }
  function duetAutoContinue(progress) {
    return !progress || (progress.autoContinue !== false && !duetNeedsCheckpoint(progress));
  }
  function renderChanges(changes) {
    if (!Array.isArray(changes) || !changes.length) return '';
    return '<div class="scene-note">变量变化：' + changes.map(function (change) {
      return '<span>' + escapeText(change.key) + '：' + escapeText(valueText(change.before)) + ' → ' + escapeText(valueText(change.after)) + '</span>';
    }).join(' · ') + '</div>';
  }
  function messageHtml(author, content, kind, pending) {
    return '<article class="message ' + kind + '">' +
      '<div class="message-meta"><span>' + escapeText(author) + '</span></div>' +
      '<div class="message-body' + (pending ? ' pending' : '') + '">' + (pending ? escapeText(content) : formatText(content)) + '</div>' +
      '</article>';
  }
  function renderChat(progress) {
    if (!progress) return;
    var list = $('chat-list');
    var wasNearBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    var oldScrollTop = list ? list.scrollTop : 0;
    var characterName = progress.characterName || (currentCharacter() && currentCharacter().name) || '角色卡';
    var isDuet = progress.mode === 'duet' || progress.testType === 'duet';
    $('chat-title').textContent = characterName + (isDuet ? ' · 代笔对戏' : ' · 测试过程');
    var paceLabel = duetPaceLabel(progress);
    var autoContinue = duetAutoContinue(progress);
    $('chat-description').textContent = isDuet
      ? (paceLabel ? '当前节奏：' + paceLabel + '。' : '') + (duetNeedsCheckpoint(progress)
        ? '这一小节已推进到安全上限，回主对话决定下一步。'
        : autoContinue
          ? '普通回合会自动继续，到了关键剧情再回主对话请你拍板。'
          : '每轮保留方向控制，出现敏感变化前会先停下来。')
      : '这里显示小花实际发出的测试台词和角色卡的逐幕回复。判断、问题和建议会在主对话里说明。';
    $('chat-eyebrow').textContent = progress.status === 'done'
      ? '花酿 · 测试完成'
      : progress.status === 'ended' ? '花酿 · 对戏结束'
      : progress.status === 'error' ? (isDuet ? '花酿 · 对戏未完成' : '花酿 · 测卡未完成')
      : isDuet ? '花酿 · 代笔对戏' : '花酿 · 实时测卡';
    var scenes = Array.isArray(progress.scenes) ? progress.scenes : [];
    var html = [];
    if (progress.opening) html.push(messageHtml(characterName, progress.opening, 'from-character', false));
    scenes.forEach(function (scene) {
      html.push(messageHtml((isDuet ? '小花代笔 · 第 ' : '小花 · 第 ') + scene.index + ' 幕', scene.user || '', 'from-tester', false));
      html.push(messageHtml(characterName, scene.reply || '（角色没有返回可见正文）', 'from-character', false));
      html.push(renderChanges(scene.variableChanges));
    });
    var active = progress.activeScene;
    var activeIndex = active && Number(active.index);
    if (active && !scenes.some(function (scene) { return Number(scene.index) === activeIndex; })) {
      html.push(messageHtml((isDuet ? '小花代笔 · 第 ' : '小花 · 第 ') + active.index + ' 幕', active.user || '', 'from-tester', false));
      html.push(messageHtml(characterName, '正在生成这一幕的回复…', 'from-character', true));
    }
    if (!html.length) {
      var emptyText = progress.status === 'waiting'
        ? '小花正在准备测试台词…'
        : progress.status === 'waiting_for_direction' && isDuet
          ? (duetNeedsCheckpoint(progress)
            ? '这一小节先停在这里，等你决定下一步…'
            : scenes.length && duetAutoContinue(progress) ? '小花会按当前节奏继续推进…' : '等你告诉小花，这场戏接下来往哪边走…')
          : progress.status === 'error' ? '这次测试没有留下可显示的过程。' : '正在连接真实 SillyTavern…';
      html.push('<div class="chat-empty">' + emptyText + '</div>');
    }
    list.innerHTML = html.join('');
    var state = isDuet ? (duetAutoContinue(progress) ? '按当前节奏推进中' : '等待你的方向') : '等待开始';
    if (progress.status === 'running') state = active
      ? (isDuet ? (duetAutoContinue(progress) ? '自动推进第 ' : '正在等角色回应第 ') : '正在测试第 ') + active.index + ' 幕'
      : '正在准备真实酒馆…';
    if (progress.status === 'waiting_for_direction' && isDuet) state = scenes.length
      ? (duetNeedsCheckpoint(progress)
        ? '这一小节已暂停，等你决定下一步'
        : duetAutoContinue(progress) ? '普通回合会自动继续，关键剧情再等你拍板' : '等你决定下一步怎么演')
      : '等你给这场戏一句方向';
    if (progress.status === 'done') state = '测试过程已完成，结论在主对话里';
    if (progress.status === 'ended') state = '这场对戏已结束，临时聊天已清理';
    if (progress.status === 'error') state = (isDuet ? '对戏未完成：' : '测试未完成：') + (progress.error || '真实测卡失败');
    $('chat-status').textContent = state;
    $('chat-status').className = 'chat-status' + (progress.status === 'error' ? ' error' : '');
    $('chat-reopen').hidden = progress.status !== 'error';
    $('chat-end').hidden = !isDuet || ['ended', 'done'].includes(progress.status);
    if (wasNearBottom) list.scrollTop = list.scrollHeight;
    else list.scrollTop = oldScrollTop;
  }
  function enterChat(progress) {
    activeProgress = progress;
    pollFailures = 0;
    waitingSince = progress.status === 'waiting' ? Date.now() : 0;
    document.body.setAttribute('data-mode', 'chat');
    $('selection-screen').hidden = true;
    $('chat-screen').hidden = false;
    renderChat(progress);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
  function reopenSelection() {
    stopPolling();
    activeProgress = null;
    waitingSince = 0;
    var nextUrl = new URL(location.href);
    nextUrl.searchParams.delete('runId');
    history.replaceState(null, '', nextUrl.toString());
    document.body.removeAttribute('data-mode');
    $('selection-screen').hidden = false;
    $('chat-screen').hidden = true;
    $('handoff').disabled = false;
    $('handoff').textContent = selectedTest === 'duet' ? '发给小花开始对戏' : '发给小花开始测试';
    showStatus('可以重新选择角色卡和测试方式。', false);
  }
  function endDuet() {
    if (!activeProgress || !activeProgress.runId) return;
    if (!window.confirm('结束这场代笔对戏？临时聊天会被清理，卡片里的过程会保留。')) return;
    var headers = authHeaders();
    headers['Content-Type'] = 'application/json';
    var query = new URLSearchParams(location.search);
    $('chat-end').disabled = true;
    fetch(pluginBase() + '/card/theater/control', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        runId: activeProgress.runId,
        action: 'end',
        sessionId: query.get('sessionId') || '',
        sessionPath: query.get('sessionPath') || '',
        sessionRef: query.get('sessionRef') || ''
      }),
      signal: AbortSignal.timeout(10000)
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok || payload.ok === false) throw Error(payload.error || '结束对戏失败。');
        return payload.progress || payload;
      });
    }).then(function (payload) {
      activeProgress = payload;
      renderChat(payload);
      stopPolling();
    }).catch(function (error) {
      $('chat-end').disabled = false;
      $('chat-status').textContent = error.message || '结束对戏失败，请稍后重试。';
      $('chat-status').className = 'chat-status error';
    });
  }
  function pollProgress() {
    if (!activeProgress || !activeProgress.runId || pollInFlight) return;
    if (activeProgress.status === 'waiting' && waitingSince && Date.now() - waitingSince > WAITING_TIMEOUT_MS) {
      activeProgress = Object.assign({}, activeProgress, {
        status: 'error',
        error: '小花还没有开始这次测卡，请重新打开小剧场重试。',
      });
      stopPolling();
      renderChat(activeProgress);
      return;
    }
    pollInFlight = true;
    var progressQuery = new URLSearchParams();
    progressQuery.set('runId', activeProgress.runId);
    var pageQuery = new URLSearchParams(location.search);
    if (pageQuery.get('sessionId')) progressQuery.set('sessionId', pageQuery.get('sessionId'));
    if (pageQuery.get('sessionPath')) progressQuery.set('sessionPath', pageQuery.get('sessionPath'));
    if (pageQuery.get('sessionRef')) progressQuery.set('sessionRef', pageQuery.get('sessionRef'));
    fetch(pluginBase() + '/card/theater/progress?' + progressQuery.toString(), {
      headers: authHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000)
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) {
          var error = Error(payload.error || '测试过程读取失败。');
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    }).then(function (payload) {
      pollFailures = 0;
      if (payload.status !== 'waiting') waitingSince = 0;
      activeProgress = payload;
      renderChat(payload);
      if (payload.status === 'done' || payload.status === 'ended' || payload.status === 'error') stopPolling();
    }).catch(function (error) {
      if (!activeProgress || ['done', 'ended', 'error'].includes(activeProgress.status)) return;
      if (error.status === 404) {
        activeProgress = Object.assign({}, activeProgress, {
          status: 'error',
          error: '这次测试记录已过期或 Hana 刚刚重启，请重新打开小剧场。',
        });
        stopPolling();
        renderChat(activeProgress);
        return;
      }
      pollFailures += 1;
      if (pollFailures >= 8) {
        activeProgress = Object.assign({}, activeProgress, {
          status: 'error',
          error: '暂时无法读取测试过程，请重新打开小剧场重试。',
        });
        stopPolling();
        renderChat(activeProgress);
        return;
      }
      $('chat-status').textContent = '暂时读不到测试过程，正在重试…';
    }).then(function () {
      pollInFlight = false;
    });
  }
  function startPolling() {
    stopPolling();
    pollFailures = 0;
    if (activeProgress && activeProgress.status === 'waiting' && !waitingSince) waitingSince = Date.now();
    pollProgress();
    pollTimer = setInterval(pollProgress, 650);
  }
  function sendToHana() {
    if (!canHandoff) {
      showStatus('这张卡用于介绍测卡功能。请在任意 Hana 对话里直接说「帮我测一下这张角色卡」，小花会打开可执行的小剧场。', false);
      return;
    }
    var character = currentCharacter();
    if (!character) {
      showStatus('还没有可测试的角色卡。', true);
      return;
    }
    var button = $('handoff');
    var isDuet = selectedTest === 'duet';
    var text = isDuet
      ? '小剧场卡片已选定角色卡「' + character.name + '」，模式：代笔对戏。请严格使用这张卡，不要改用当前活动角色。现在先告诉用户已经进入代笔对戏，并等待用户在当前对话给出一句大概方向，不要提前调用酒馆或预写多轮。收到方向后，由你把它改写成一条自然的第一人称玩家侧消息，再调用 tavern-duet-start；playerMessage 只能放角色能看到的正文，不能夹带导演说明、测试目的、变量名或隐藏规则。启动后按用户选的节奏推进：普通回合不要每一轮都把结果带回当前对话等待用户，而要在同一次助手回复里继续自然代写下一条玩家消息并调用 tavern-duet-turn；每次工具调用仍只推进一轮，保证卡片逐轮展示。自由发展只在重大剧情、不可逆选择或明确边界节点暂停；慢慢推进在关键剧情、关系变化、越界或重大时间跳跃时暂停；保持克制则每轮保留方向控制，出现敏感变化前先停。只有到了暂停点，才把已完成过程带回当前对话并询问用户下一步。用户明确说结束、退出或换一场时才调用 tavern-duet-end。卡片会同步显示开场、代笔台词、角色回复和变量变化，变量读不到就明确标成不可用。用户在卡片里选的推进节奏是「' + selectedDetail + '」，之后以用户实时方向为准。'
      : '小剧场卡片已选定角色卡「' + character.name + '」。请严格测试这张卡，不要改用当前活动角色。测试方式：' + tests[selectedTest].label + '；测试重点：' + selectedDetail + '。请调用真实隔离测卡工具，自动设计 3～6 幕测试台词。测试过程中的台词和角色回复同步显示在小剧场卡片里；测试结束后只在当前对话正文分析逐幕表现、变量前后变化、是否正常、逻辑是否合理和优化建议。';
    button.disabled = true;
    button.textContent = isDuet ? '正在交给小花…' : '正在交给小花…';
    showStatus('正在建立测试过程卡片…', false);
    var query = new URLSearchParams(location.search);
    var headers = authHeaders();
    headers['Content-Type'] = 'application/json';
    fetch(pluginBase() + '/card/theater/handoff', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        request: text,
        characterId: character.id,
        characterName: character.name,
        testType: selectedTest,
        detail: selectedDetail,
        sessionId: query.get('sessionId') || '',
        sessionPath: query.get('sessionPath') || '',
        sessionRef: query.get('sessionRef') || ''
      }),
      signal: AbortSignal.timeout(10000)
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok || payload.ok === false) throw Error(payload.error || '测试目标发送失败。');
        if (!payload.runId) throw Error('测试过程卡片没有拿到测试编号。');
        return payload;
      });
    }).then(function (payload) {
      var nextUrl = new URL(location.href);
      nextUrl.searchParams.set('runId', payload.runId);
      history.replaceState(null, '', nextUrl.toString());
      enterChat({
        runId: payload.runId,
        mode: selectedTest === 'duet' ? 'duet' : 'scripted',
        status: selectedTest === 'duet' ? 'waiting_for_direction' : 'waiting',
        characterId: character.id,
        characterName: character.name,
        testType: selectedTest,
        detail: selectedDetail,
        paceLabel: selectedTest === 'duet' ? selectedDetail : '',
        autoContinue: selectedTest === 'duet' ? selectedDetail !== '保持克制' : false,
        scenes: [],
        opening: '',
        activeScene: null
      });
      startPolling();
    }).catch(function (error) {
      var uncertain = error && (error.name === 'TimeoutError' || error.name === 'AbortError' || /timeout|aborted/i.test(String(error.message || error)));
      if (uncertain) {
        showStatus('交接状态暂时无法确认，可能已经送达；请先看主对话，不要重复点击。', true);
        button.disabled = true;
        button.textContent = '已提交，等待确认…';
        return;
      }
      showStatus(error.message || '交接失败，请直接在当前对话里说测试目标。', true);
      button.disabled = false;
      button.textContent = selectedTest === 'duet' ? '发给小花开始对戏' : '发给小花开始测试';
    });
  }

  document.querySelectorAll('[data-character]').forEach(function (el) {
    el.addEventListener('click', function () {
      selectedCharacter = el.getAttribute('data-character');
      setSelected('[data-character]', 'data-character', selectedCharacter);
      renderDetails();
    });
  });
  document.querySelectorAll('[data-test]').forEach(function (el) {
    el.addEventListener('click', function () {
      selectedTest = el.getAttribute('data-test');
      setSelected('[data-test]', 'data-test', selectedTest);
      renderDetails();
    });
  });
  $('details').addEventListener('click', function (event) {
    var el = event.target.closest('[data-detail]');
    if (!el) return;
    selectedDetail = el.getAttribute('data-detail');
    setSelected('[data-detail]', 'data-detail', selectedDetail);
  });
  $('handoff').addEventListener('click', sendToHana);
  $('chat-reopen').addEventListener('click', reopenSelection);
  $('chat-end').addEventListener('click', endDuet);
  renderDetails();
  if (!canHandoff) {
    $('handoff').disabled = true;
    $('handoff').textContent = '请在对话里说「帮我测卡」';
    showStatus('这是角色卡体检的说明入口。真正开始测卡，请在任意 Hana 对话里说「帮我测一下这张角色卡」。', false);
  }
  if (activeProgress && activeProgress.runId) {
    selectedCharacter = activeProgress.characterId || selectedCharacter;
    selectedTest = activeProgress.mode === 'duet' || activeProgress.testType === 'duet' ? 'duet' : selectedTest;
    enterChat(activeProgress);
    if (!['done', 'ended', 'error'].includes(activeProgress.status)) startPolling();
  } else if (initialRunId) {
    showStatus('这次测试记录已过期，请重新选择目标。', true);
  }
  window.parent.postMessage({ protocol: 'hana.plugin.ui', version: 1, kind: 'event', type: 'hana.ready' }, '*');
}());`;
}

export function renderTheater(data) {
  const characters = (data.characters || []).map((character) => ({
    id: String(character.id || ''),
    name: String(character.name || ''),
    variables: (character.variables || []).map((variable) => String(variable)),
  }));
  const initialCharacterId = String(data.activeCharacterId || characters[0]?.id || '');
  const progress = data.progress || null;
  const canHandoff = data.canHandoff !== false;
  const characterCards = characters.length
    ? characters.map((character) => `<button type="button" class="choice character-choice${character.id === initialCharacterId ? ' selected' : ''}" data-character="${esc(character.id)}"><span>${esc(character.name)}</span><small>${character.variables.length ? `${character.variables.length} 个变量` : '可测人设与场景'}</small></button>`).join('')
    : '<div class="empty">还没有角色卡，请先导入或创建一张。</div>';
  const testCards = [
    ['mvu', 'MVU 变量', '检查变量是否按条件变化'],
    ['duet', '代笔对戏', '你定方向，小花替你开口'],
    ['persona', '人设稳定', '检查说话方式和行为边界'],
    ['opening', '开场白', '检查第一幕是否自然接住'],
    ['worldbook', '世界书', '检查设定是否被正确触发'],
    ['scene', '场景逻辑', '检查事件推进是否合理'],
    ['boundary', '边界情况', '检查冲突、拒绝和异常输入'],
  ].map(([id, title, note]) => `<button type="button" class="choice${id === 'mvu' ? ' selected' : ''}" data-test="${id}"><span>${title}</span><small>${note}</small></button>`).join('');
  const script = theaterClientScript({
    characters,
    initialCharacterId,
    initialProgress: progress,
    initialRunId: String(data.initialRunId || ''),
    canHandoff,
  });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>花酿 · 小剧场</title><style>
:root{--paper:#fffaf3;--paper-warm:#fffdf9;--deep:#f6eee4;--mint:#5dae8e;--mint-deep:#3f8068;--soft:#e4f2eb;--ink:#4c4a47;--muted:#8d8881;--line:#eadfd3;--pink:#d98da5}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:transparent;font-family:"LXGW WenKai","霞鹜文楷","Noto Sans SC",system-ui,sans-serif}*[hidden]{display:none!important}.theater{width:min(100%,760px);margin:auto;overflow:hidden;border:1px solid var(--line);border-radius:22px;background:var(--paper);box-shadow:0 12px 28px rgba(112,83,65,.1)}body[data-mode="chat"] .theater{max-height:680px;display:flex;flex-direction:column}body[data-mode="chat"] #chat-screen{min-height:0;display:flex;flex:1;flex-direction:column}html[data-card-sizing="viewport"],html[data-card-sizing="viewport"] body{width:100%;height:100%;overflow:hidden}html[data-card-sizing="viewport"] body[data-mode="chat"]{display:flex}html[data-card-sizing="viewport"] body[data-mode="chat"] .theater{height:100%;max-height:none;margin:0 auto}html[data-card-sizing="viewport"] body[data-mode="chat"] #chat-screen{height:100%}header{position:relative;padding:22px 22px 20px;background:var(--deep);border-bottom:1px solid var(--line)}header:after{content:"";position:absolute;right:22px;bottom:-1px;width:74px;height:3px;background:var(--pink);border-radius:4px}.eyebrow{color:var(--mint-deep);font:600 11px system-ui;letter-spacing:.1em}h1{margin:6px 0 5px;font-size:25px;letter-spacing:.02em}p{margin:0;color:var(--muted);font-size:13px;line-height:1.65}.body{padding:20px 22px 22px}.group{margin-bottom:20px}.label{display:flex;align-items:center;gap:8px;margin-bottom:10px;color:var(--mint-deep);font:600 12px system-ui;letter-spacing:.02em}.label:after{content:"";height:1px;flex:1;background:var(--line)}.choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.choice{position:relative;min-width:0;border:1px solid var(--line);border-radius:13px;padding:12px 13px;background:var(--paper-warm);color:var(--ink);text-align:left;font:inherit;cursor:pointer;transition:background .16s ease,border-color .16s ease,transform .16s ease,box-shadow .16s ease}.choice:hover{border-color:#9ac9b2;background:var(--soft);transform:translateY(-1px);box-shadow:0 4px 10px rgba(78,126,103,.08)}.choice:focus-visible,.primary:focus-visible{outline:3px solid rgba(217,141,165,.35);outline-offset:2px}.choice.selected{border-color:var(--mint);background:var(--soft);box-shadow:inset 3px 0 0 var(--mint),0 3px 9px rgba(78,126,103,.08)}.choice.selected:after{content:"✓";position:absolute;right:10px;top:9px;color:var(--mint-deep);font:600 13px system-ui}.choice span,.choice small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.choice span{font-size:13px}.choice small{margin-top:5px;color:var(--muted);font-size:11px}.subchoices{display:flex;flex-wrap:wrap;gap:8px}.subchoices .choice{padding:9px 12px;text-align:center;font-size:12px}.primary{width:100%;border:0;border-radius:13px;padding:12px 16px;background:var(--mint);color:#fff;font:600 14px inherit;cursor:pointer;box-shadow:0 5px 12px rgba(63,128,104,.16);transition:background .16s ease,transform .16s ease,box-shadow .16s ease}.primary:hover{background:var(--mint-deep);transform:translateY(-1px);box-shadow:0 7px 15px rgba(63,128,104,.2)}.primary:disabled{opacity:.6;cursor:wait;transform:none}.status{min-height:20px;margin-top:10px;color:var(--muted);font-size:12px}.status.error,.chat-status.error{color:#b65e72}.hint{margin-top:14px;padding:12px 13px;border-radius:12px;background:var(--soft);color:var(--mint-deep);font-size:12px;line-height:1.65}.empty{grid-column:1/-1;padding:15px;text-align:center;color:var(--muted);font-size:13px}.chat-head{padding-bottom:16px}.chat-head h1{font-size:21px}.chat-body{min-height:0;flex:1;padding:14px 18px 18px;overflow:auto}.chat-list{display:grid;gap:9px;min-height:0;align-content:start}.message{max-width:90%}.message.from-tester{justify-self:end}.message.from-character{justify-self:start}.message-meta{margin:0 8px 3px;color:var(--muted);font:11px/1.3 system-ui,sans-serif}.from-tester .message-meta{text-align:right}.message-body{padding:9px 12px;border:1px solid var(--line);border-radius:14px;background:var(--paper-warm);font-size:14px;line-height:1.65;overflow-wrap:anywhere}.from-tester .message-body{border-color:#c7e4d5;background:var(--soft)}.message-body.pending{color:var(--muted);font-style:italic}.scene-note{grid-column:1/-1;margin:-3px 8px 3px;color:var(--mint-deep);font:11px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}.scene-note span{display:inline}.chat-empty{padding:28px 14px;border:1px dashed var(--line);border-radius:14px;color:var(--muted);text-align:center;font-size:13px}.chat-status{min-height:20px;padding:0 18px 14px;color:var(--muted);font:12px/1.5 system-ui,sans-serif}.chat-note{padding:10px 18px 15px;border-top:1px solid var(--line);color:var(--muted);font:11px/1.5 system-ui,sans-serif}.chat-reopen{display:block;margin:0 18px 12px;padding:7px 11px;border:1px solid var(--line);border-radius:10px;background:var(--paper-warm);color:var(--mint-deep);font:12px system-ui,sans-serif;cursor:pointer}.chat-reopen:hover{border-color:var(--mint);background:var(--soft)}*::-webkit-scrollbar{width:8px;height:8px}*::-webkit-scrollbar-track{background:transparent}*::-webkit-scrollbar-thumb{background:#c9dfd3;border-radius:99px;border:2px solid var(--paper)}*::-webkit-scrollbar-thumb:hover{background:var(--mint)}*{scrollbar-width:thin;scrollbar-color:#c9dfd3 transparent}@media(max-width:520px){.body{padding:16px 14px 18px}.theater{border-radius:16px}.choices{grid-template-columns:1fr}header{padding:19px 17px 18px}.chat-body{padding-left:14px;padding-right:14px}.chat-status,.chat-note{padding-left:14px;padding-right:14px}}@media(prefers-reduced-motion:reduce){.choice,.primary{transition:none}.choice:hover,.primary:hover{transform:none}}
</style></head><body><main class="theater"><section id="selection-screen"><header><div class="eyebrow">花酿 · 体检</div><h1>卡片实验室</h1><p>先选人物和测试方式。发给小花后，这张卡会变成透明的测试聊天，逐幕展示测试台词和角色回复。不知道从哪里开始，也可以在当前对话直接说「帮我测一下这张角色卡」。</p></header><section class="body"><div class="group"><span class="label">1 · 选择角色卡</span><div id="characters" class="choices">${characterCards}</div></div><div class="group"><span class="label">2 · 选择测试方式</span><div id="tests" class="choices">${testCards}</div></div><div class="group" id="detail-group"><span class="label" id="detail-label">3 · 选择测试重点</span><div id="details" class="subchoices"></div></div><button id="handoff" class="primary" type="button">发给小花开始测试</button><div id="status" class="status" role="status" aria-live="polite"></div><div class="hint">不知道从哪里开始？在当前对话直接说「帮我测一下这张角色卡」「试演一下这个角色」或「看看这张卡的变量有没有生效」。固定测卡和代笔对戏都会在真实 SillyTavern 前端的隔离临时聊天里运行，世界书、EJS、MVU 和扩展按酒馆实际流程生效；固定测卡的结论回到当前对话正文，代笔对戏按你选的节奏自动推进，关键剧情才回当前对话问你。</div></section></section><section id="chat-screen" hidden><header class="chat-head"><div id="chat-eyebrow" class="eyebrow">花酿 · 实时测卡</div><h1 id="chat-title">测试过程</h1><p id="chat-description">这里显示小花实际发出的测试台词和角色卡的逐幕回复。判断、问题和建议会在主对话里说明。</p></header><div class="chat-body"><div id="chat-list" class="chat-list"></div></div><div id="chat-status" class="chat-status" role="status" aria-live="polite">正在准备…</div><button id="chat-end" class="chat-reopen" type="button" hidden>结束这场对戏</button><button id="chat-reopen" class="chat-reopen" type="button" hidden>重新打开小剧场</button><div class="chat-note">固定测卡只记录测试过程；代笔对戏按所选节奏连续推进，普通回合留在卡片里，关键剧情和选择回到主对话里。</div></section></main><script>${script}</script></body></html>`;
}

async function parseJson(c) {
  try { return await c.req.json(); } catch { return {}; }
}

function requestContext(c) {
  return c?.get?.('pluginRequestContext') || {};
}

function requestSessionContext(c, ctx = {}, body = {}) {
  const request = requestContext(c);
  const query = (name) => (typeof c?.req?.query === 'function' ? c.req.query(name) : '');
  return {
    ...ctx,
    ...request,
    sessionId: request.sessionId || ctx.sessionId || body.sessionId || query('sessionId'),
    sessionRef: request.sessionRef || ctx.sessionRef || body.sessionRef || query('sessionRef'),
    sessionPath: request.sessionPath || ctx.sessionPath || body.sessionPath || query('sessionPath'),
  };
}

export default function registerTheaterRoutes(app, ctx = {}) {
  app.get('/card/theater', async (c) => {
    const state = await readState(ctx);
    const characters = await listCharacters(ctx);
    const initialRunId = String(c.req.query('runId') || '');
    const sessionCtx = requestSessionContext(c, ctx);
    return c.html(renderTheater({
      // 这里不读取 Hana 侧 mvu-state.json；变量由真实 ST 临时聊天运行时回传。
      characters: characters.map((character) => ({ ...character, variables: [] })),
      activeCharacterId: state.activeCharacterId,
      progress: initialRunId ? getTheaterProgressForSession(initialRunId, sessionCtx) : null,
      initialRunId,
      canHandoff: Boolean(sessionCtx.sessionId || sessionCtx.sessionRef || sessionCtx.sessionPath),
    }));
  });

  app.get('/card/theater/progress', (c) => {
    const runId = String(c.req.query('runId') || '');
    const progress = getTheaterProgressForSession(runId, requestSessionContext(c, ctx));
    if (!progress) return c.json({ ok: false, error: '测试过程不存在、已过期或不属于当前对话。' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json(progress);
  });

  app.post('/card/theater/handoff', async (c) => {
    const body = await parseJson(c);
    const text = String(body.request || '').trim();
    const sessionCtx = requestSessionContext(c, ctx, body);
    const { sessionId, sessionRef, sessionPath } = sessionCtx;
    if (!text) return c.json({ ok: false, error: '测试目标为空。' }, 400);
    if (!sessionId && !sessionRef && !sessionPath) return c.json({ ok: false, error: '当前卡片没有绑定到对话会话，请直接在对话里说测试目标。' }, 409);
    if (!ctx.bus || typeof ctx.bus.request !== 'function') return c.json({ ok: false, error: '当前 Hana 会话通道不可用，请直接在对话里说测试目标。' }, 503);

    const progress = createTheaterProgress({
      sessionId,
      sessionRef,
      sessionPath,
      characterId: body.characterId,
      characterName: body.characterName,
      testType: body.testType,
      mode: body.testType === 'duet' ? 'duet' : 'scripted',
      detail: body.detail,
    });
    try {
      const result = await ctx.bus.request('session:send', { text, sessionId, sessionRef, sessionPath }, { timeoutMs: 10000 });
      return c.json({ ok: true, runId: progress.runId, result });
    } catch (error) {
      discardTheaterProgress(progress.runId);
      return c.json({ ok: false, error: error.message || '测试目标发送失败。' }, 502);
    }
  });

  app.post('/card/theater/control', async (c) => {
    const body = await parseJson(c);
    const runId = String(body.runId || '').trim();
    const action = String(body.action || '').trim();
    if (!runId) return c.json({ ok: false, error: '缺少小剧场过程编号。' }, 400);
    if (action !== 'end') return c.json({ ok: false, error: '不支持这个小剧场操作。' }, 400);
    const runtimeCtx = requestSessionContext(c, ctx, body);
    const progress = getTheaterProgressForSession(runId, runtimeCtx);
    if (!progress) return c.json({ ok: false, error: '这场对戏不存在、已过期或不属于当前对话。' }, 404);
    if (progress.mode !== 'duet' && progress.testType !== 'duet') {
      return c.json({ ok: false, error: '只有代笔对戏可以从卡片结束。' }, 400);
    }
    try {
      await endTheaterDuet({ progressId: runId }, runtimeCtx);
      return c.json({ ok: true, progress: getTheaterProgress(runId) });
    } catch (error) {
      return c.json({ ok: false, error: error.message || '结束对戏失败。' }, 502);
    }
  });
}
