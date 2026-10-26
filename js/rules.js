/* 阿瓦隆规则常量与配置工具。浏览器下挂到 window.Avalon，Node 下通过 module.exports 导出。 */
(function (root) {
  'use strict';

  // 每轮任务所需人数（下标为任务序号 0-4）
  const TEAM_SIZES = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4],
    8: [3, 4, 4, 5, 5],
    9: [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5],
  };

  const EVIL_COUNT = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };

  const ROLES = {
    merlin: {
      name: '梅林', team: 'good',
      desc: '你能看到除莫德雷德以外的所有坏人。帮助好人完成任务，但别暴露自己：好人赢下三次任务后，刺客还有一次刺杀你的机会。',
    },
    percival: {
      name: '派西维尔', team: 'good',
      desc: '你能看到梅林和莫甘娜，但分不清谁是谁。保护真正的梅林。',
    },
    servant: {
      name: '亚瑟的忠臣', team: 'good',
      desc: '你没有额外信息。通过组队、投票和任务结果找出坏人。',
    },
    assassin: {
      name: '刺客', team: 'evil',
      desc: '你认识其他坏人（奥伯伦除外）。好人赢下三次任务后，由你刺杀梅林，刺中则坏人翻盘。',
    },
    morgana: {
      name: '莫甘娜', team: 'evil',
      desc: '你认识其他坏人（奥伯伦除外）。在派西维尔眼中，你和梅林看起来一样。',
    },
    mordred: {
      name: '莫德雷德', team: 'evil',
      desc: '你认识其他坏人（奥伯伦除外）。梅林看不到你。',
    },
    oberon: {
      name: '奥伯伦', team: 'evil',
      desc: '你是坏人，但你不认识其他坏人，他们也不认识你。梅林能看到你。',
    },
    minion: {
      name: '莫德雷德的爪牙', team: 'evil',
      desc: '你认识其他坏人（奥伯伦除外）。帮助坏人让三次任务失败。',
    },
  };

  const OPTIONAL_GOOD = ['percival'];
  const OPTIONAL_EVIL = ['morgana', 'mordred', 'oberon'];

  const MIN_PLAYERS = 5;
  const MAX_PLAYERS = 10;

  function goodCount(n) {
    return n - EVIL_COUNT[n];
  }

  // 第 4 个任务（下标 3）在 7 人及以上时需要两张失败票才算失败
  function requiredFails(n, round) {
    return n >= 7 && round === 3 ? 2 : 1;
  }

  // 各人数下推荐的可选角色组合
  function defaultOptions(n) {
    const opts = { percival: true, morgana: true, mordred: false, oberon: false, lady: n >= 7 };
    if (n === 7) opts.oberon = true;
    if (n === 8 || n === 9) opts.mordred = true;
    if (n === 10) { opts.mordred = true; opts.oberon = true; }
    return opts;
  }

  // 校验可选角色组合，返回错误信息数组（空数组表示合法）
  function validateOptions(n, opts) {
    const errors = [];
    if (!TEAM_SIZES[n]) {
      errors.push(`人数需在 ${MIN_PLAYERS}-${MAX_PLAYERS} 之间`);
      return errors;
    }
    const evilSpecial = 1 + OPTIONAL_EVIL.filter((r) => opts[r]).length; // 刺客必选
    if (evilSpecial > EVIL_COUNT[n]) {
      errors.push(`${n} 人局只有 ${EVIL_COUNT[n]} 名坏人，最多再选 ${EVIL_COUNT[n] - 1} 个坏人角色`);
    }
    const goodSpecial = 1 + OPTIONAL_GOOD.filter((r) => opts[r]).length; // 梅林必选
    if (goodSpecial > goodCount(n)) {
      errors.push('好人特殊角色过多');
    }
    return errors;
  }

  // 按配置生成本局角色列表（未洗牌）
  function buildRoleList(n, opts) {
    const errors = validateOptions(n, opts);
    if (errors.length) throw new Error(errors.join('；'));
    const good = ['merlin'];
    OPTIONAL_GOOD.forEach((r) => { if (opts[r]) good.push(r); });
    while (good.length < goodCount(n)) good.push('servant');
    const evil = ['assassin'];
    OPTIONAL_EVIL.forEach((r) => { if (opts[r]) evil.push(r); });
    while (evil.length < EVIL_COUNT[n]) evil.push('minion');
    return good.concat(evil);
  }

  const api = {
    TEAM_SIZES, EVIL_COUNT, ROLES, OPTIONAL_GOOD, OPTIONAL_EVIL, MIN_PLAYERS, MAX_PLAYERS,
    goodCount, requiredFails, defaultOptions, validateOptions, buildRoleList,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign((root.Avalon = root.Avalon || {}), api);
})(typeof window !== 'undefined' ? window : globalThis);
