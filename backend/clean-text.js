// 花酿文本清洗：Hana 侧统一兜底，替代酒馆里的「正则替换 / 脚本宏展开」。
// 角色卡设定、历史对话、模型回复里可能带着酒馆生态的宏与隐藏块
// （MVU <UpdateVariable>、<Analysis>、<thinking> 等），Hana 没有渲染管线，
// 模型会把宏的“执行痕迹”直接写进正文。这里在三个出口统一清洗：
//   1. 角色快照写入人格文件前
//   2. 历史对话写入人格文件前
//   3. 模型回复入库/展示前（最关键的治本出口）
//
// 例外：MVU 的“规则块”（<update_variable_rules> / <status_current_variable>）
// 是角色卡的变量协议，需要保留给花酿的 MVU 引擎解析，不能剥掉。
// 用 cleanTavernTextKeepMvu() 清洗角色快照；普通 cleanTavernText() 用于回复/历史。

/** 需要按成对标签整体移除的隐藏块（大小写不敏感）。 */
function normalizeUserName(value) {
  const name = String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  return name || '用户';
}

const PAIRED_BLOCK_NAMES = [
  'UpdateVariable', 'Analysis', 'JSONPatch', 'Macro', 'Style', 'Script',
  'think', 'thinking', 'thought', 'reasoning', 'analysis', 'mvu', 'system', 'system_prompt',
];

/** 需要保留的 MVU 规则块（大小写不敏感）。 */
const MVU_RULE_BLOCKS = new Set(['update_variable_rules', 'status_current_variable']);

/** 需要移除的裸标签名（没配对出现时的孤立开/闭标签）。 */
const BARE_TAG_NAMES = [
  'UpdateVariable', 'Analysis', 'JSONPatch', 'Macro', 'Style', 'Script',
  'think', 'thinking', 'thought', 'reasoning', 'analysis', 'mvu', 'system', 'system_prompt',
  'StatusPlaceHolderImpl', 'statusplaceholderimpl',
];

/** 需要整体移除的自闭合占位标签（酒馆渲染占位，如 <StatusPlaceHolderImpl/>）。 */
const SELF_CLOSED_TAG_NAMES = new Set([
  'StatusPlaceHolderImpl',
]);

/** 保留 MVU 规则块但剥掉其余隐藏块。 */
export function cleanTavernTextKeepMvu(input, options = {}) {
  return cleanTavernText(String(input == null ? '' : input), { ...options, keepMvuRules: true });
}

/**
 * 把一块文本里的酒馆宏与隐藏块剥掉，返回可读正文。
 *
 * 设计原则：只做“能确定是机器/渲染层内容”的删除，绝不猜着删用户或
 * 角色的真实正文。宏标签出现的位置、写法千奇百怪（可能带属性、可能换行），
 * 所以用分块状态机处理成对标签，而不是依赖正则的完美匹配。
 */
export function cleanTavernText(input, options = {}) {
  const text = String(input == null ? '' : input);
  if (!text) return '';
  const keepMvuRules = Boolean(options?.keepMvuRules);
  const userName = normalizeUserName(options?.userName);

  // 1) 成对隐藏块整体移除（大小写不敏感，标签可带任意属性，容忍跨行）
  //    默认剥掉所有隐藏块；keepMvuRules 时保留 MVU 规则块本身（内容随之保留）
  let cleaned = stripPairedBlocks(text, { keepMvuRules });

  // 2) 单独的宏标签（没配对的）移除 + 自闭合占位标签移除。这些只可能是机器层注入，
  //    人类正文里几乎不会写「<UpdateVariable>」「<StatusPlaceHolderImpl/>」。
  cleaned = cleaned
    .replace(new RegExp(`</?(?:${BARE_TAG_NAMES.join('|')})(?:\\s[^>]*)?>`, 'gi'), '')
    .replace(new RegExp(`<(${Array.from(SELF_CLOSED_TAG_NAMES).join('|')})(?:\\s[^>]*)?\\/>`, 'gi'), '')
    .replace(/<\|(?:im_start|im_end|start|end)\|>/g, '');

  // 3) 酒馆宏占位符（{{...}} / <user> 等）：
  //    - {{...}} 是纯机器宏，模型回复里残留说明宏没展开，直接删。
  //    - <user> 是酒馆的“用户名称”占位符；调用方可传入当前用户名，缺省用中性称呼。
  //    注意 keepMvuRules 时 {{format_message_variable::...}} 是规则的一部分，
  //    但这里对角色快照也会删掉——由 MVU 引擎后续自行注入当前值，不冲突。
  cleaned = cleaned
    .replace(/\{\{(?:[^{}]|\{[^{}]*\})*\}\}/g, '')
    .replace(/<user>/gi, userName);

  // 4) 收尾整理：连续空行压成一段，去掉首尾空白
  cleaned = cleaned
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

/** 成对标签块整体移除的分块状态机。keepMvuRules 时保留 MVU 规则块内容。 */
function stripPairedBlocks(input, { keepMvuRules = false } = {}) {
  const lowerNames = new Set(PAIRED_BLOCK_NAMES.map((name) => name.toLowerCase()));

  const out = [];
  const stack = [];
  let index = 0;
  const length = input.length;

  while (index < length) {
    const lt = input.indexOf('<', index);
    if (lt < 0) {
      // 不在任何块内时才保留剩余正文
      if (stack.length === 0) out.push(input.slice(index));
      break;
    }
    // 块外正文保留，块内正文丢弃
    if (stack.length === 0 && lt > index) out.push(input.slice(index, lt));

    // 找 '>'，判断是否标签
    const gt = input.indexOf('>', lt + 1);
    if (gt < 0) {
      if (stack.length === 0) out.push(input.slice(lt));
      break;
    }
    const tagText = input.slice(lt + 1, gt);
    const lowerTagName = tagText.trim().split(/\s/)[0].toLowerCase();
    // keepMvuRules：MVU 规则块当作普通正文保留（连同内部标签一起）
    const isMvuRule = keepMvuRules && MVU_RULE_BLOCKS.has(lowerTagName);

    if (tagText.startsWith('/')) {
      const name = tagText.slice(1).trim().split(/\s/)[0].toLowerCase();
      const open = stack[stack.length - 1];
      const openIsMvuRule = open && MVU_RULE_BLOCKS.has(open.name);
      if (open && open.name === name && !openIsMvuRule) {
        stack.pop();
        // 不输出任何内容（成对块整体消失）
      } else {
        // 普通/规则闭合标签：原样输出（规则块整体保留，普通块闭合时若栈被规则挡住也原样）
        out.push(input.slice(lt, gt + 1));
        // 若这是 MVU 规则块的闭合标签，且它在栈里（规则块曾入栈），退栈让后续正文恢复块外语义
        if (open && open.name === name && openIsMvuRule) {
          stack.pop();
        }
      }
    } else if (!tagText.startsWith('!') && !tagText.startsWith('?')) {
      const name = tagText.trim().split(/\s/)[0].toLowerCase();
      if (isMvuRule) {
        // MVU 规则块：入栈但保留原文（连同标签一起输出）
        stack.push({ name, start: lt });
        out.push(input.slice(lt, gt + 1));
      } else if (lowerNames.has(name)) {
        stack.push({ name, start: lt });
        // 不输出标签本身
      } else if (stack.length === 0) {
        // 普通标签（HTML 之类）保留原文
        out.push(input.slice(lt, gt + 1));
      }
      // 块内的普通标签：随块一起丢弃
    } else if (stack.length === 0) {
      out.push(input.slice(lt, gt + 1));
    }
    index = gt + 1;
  }

  // 未闭合的块：把栈里还没闭合的开标签也去掉（规则块未闭合时保留其开标签）
  let result = out.join('');
  for (const entry of stack) {
    const name = entry.name;
    if (keepMvuRules && MVU_RULE_BLOCKS.has(name)) continue;
    result = result.replace(new RegExp(`<${name}(?:\\s[^>]*)?>`, 'gi'), '');
  }
  return result;
}

/**
 * 清洗消息数组（角色/用户对话），返回 { role, content } 列表。
 */
export function cleanMessages(messages = [], options = {}) {
  return messages
    .map((message) => {
      const role = message?.role === 'user' || message?.is_user === true ? 'user' : 'assistant';
      const content = cleanTavernText(message?.content ?? message?.mes ?? '', options);
      return content ? { role, content } : null;
    })
    .filter(Boolean);
}
