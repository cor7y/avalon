/* 界面与对局流程控制：人类坐 0 号位，其余座位由 AI 驱动。 */
(function () {
  'use strict';
  const A = window.Avalon;
  const AI = A.AI;
  const HUMAN = 0;
  const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
  const CN_NUM = ['一', '二', '三', '四', '五'];
  // 各阶段 AI 的"思考"时间（毫秒），再乘以节奏系数
  const DELAY = { propose: 1100, vote: 700, quest: 1000, lady: 1000, ladyClaim: 800, discuss: 950, assassinate: 1800 };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const roleName = (key) => A.ROLES[key].name;
  const teamOf = (key) => A.ROLES[key].team;

  const storage = {
    load() {
      try { return JSON.parse(window.localStorage.getItem('avalon.settings') || 'null'); } catch (e) { return null; }
    },
    save(v) {
      try { window.localStorage.setItem('avalon.settings', JSON.stringify(v)); } catch (e) { /* 存储不可用时忽略 */ }
    },
  };

  const ui = {
    game: null,
    bots: null,
    settings: null,
    timer: null,
    selection: new Set(),
    target: null,
    lastVotes: null,
    bubbles: {},
    log: [],
    freshQuest: null,
    tab: 'log',
    speak: { accuse: '', trust: '' },
    dockHtml: '',
  };

  // ---------- 名称工具 ----------
  function nameOf(id) {
    const p = ui.game.players[id];
    return p.human ? '你' : p.name;
  }
  function who(id) {
    return `<b>${esc(nameOf(id))}</b>`;
  }
  function list(ids) {
    return ids.map(who).join('、');
  }

  // ---------- 开局设置 ----------
  function defaultSettings() {
    const n = 7;
    return { n, options: A.defaultOptions(n), humanRole: 'random', level: 'normal', speed: '1' };
  }

  function rosterRoles(s) {
    if (A.validateOptions(s.n, s.options).length) return null;
    return A.buildRoleList(s.n, s.options);
  }

  function describeRoster(roles) {
    const count = {};
    roles.forEach((r) => { count[r] = (count[r] || 0) + 1; });
    const part = (team) => Object.keys(count)
      .filter((r) => teamOf(r) === team)
      .map((r) => (count[r] > 1 ? `${roleName(r)}×${count[r]}` : roleName(r)))
      .join('、');
    const g = roles.filter((r) => teamOf(r) === 'good').length;
    return `<b class="good">好人 ${g}</b>：${part('good')}<br><b class="evil">坏人 ${roles.length - g}</b>：${part('evil')}`;
  }

  function renderSetup() {
    const s = ui.settings;
    let seg = '';
    for (let n = A.MIN_PLAYERS; n <= A.MAX_PLAYERS; n++) {
      seg += `<button type="button" data-n="${n}" aria-pressed="${n === s.n}">${n}</button>`;
    }
    $('setup-count').innerHTML = seg;
    ['percival', 'morgana', 'mordred', 'oberon', 'lady'].forEach((k) => { $(`opt-${k}`).checked = !!s.options[k]; });
    const errors = A.validateOptions(s.n, s.options);
    $('setup-error').hidden = !errors.length;
    $('setup-error').textContent = errors.join('；');
    const roles = rosterRoles(s);
    $('setup-roster').innerHTML = roles ? describeRoster(roles) : '';
    const uniq = roles ? Array.from(new Set(roles)) : [];
    if (s.humanRole !== 'random' && !uniq.includes(s.humanRole)) s.humanRole = 'random';
    $('setup-role').innerHTML = ['<option value="random">随机分配</option>']
      .concat(uniq.map((r) => `<option value="${r}">${roleName(r)}（${teamOf(r) === 'good' ? '好人' : '坏人'}）</option>`))
      .join('');
    $('setup-role').value = s.humanRole;
    $('setup-level').value = s.level;
    $('setup-speed').value = s.speed;
    $('setup-form').querySelector('button[type="submit"]').disabled = !!errors.length;
    $('setup-cancel').hidden = !ui.game || ui.game.phase === 'over';
  }

  function bindSetup() {
    $('setup-count').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-n]');
      if (!b) return;
      const n = Number(b.dataset.n);
      ui.settings.n = n;
      ui.settings.options = A.defaultOptions(n);
      renderSetup();
    });
    ['percival', 'morgana', 'mordred', 'oberon', 'lady'].forEach((k) => {
      $(`opt-${k}`).addEventListener('change', (e) => {
        ui.settings.options[k] = e.target.checked;
        renderSetup();
      });
    });
    $('setup-role').addEventListener('change', (e) => { ui.settings.humanRole = e.target.value; });
    $('setup-level').addEventListener('change', (e) => { ui.settings.level = e.target.value; });
    $('setup-speed').addEventListener('change', (e) => { ui.settings.speed = e.target.value; });
    $('setup-cancel').addEventListener('click', () => { $('setup').hidden = true; });
    $('setup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (A.validateOptions(ui.settings.n, ui.settings.options).length) return;
      storage.save(ui.settings);
      $('setup').hidden = true;
      startGame();
    });
  }

  function openSetup() {
    renderSetup();
    $('setup').hidden = false;
  }

  // ---------- 对局流程 ----------
  function startGame() {
    clearTimeout(ui.timer);
    const s = ui.settings;
    ui.game = A.createGame({ numPlayers: s.n, options: s.options, humanSeat: HUMAN, humanRole: s.humanRole });
    ui.bots = AI.createBots(ui.game, { level: s.level });
    ui.selection = new Set();
    ui.target = null;
    ui.lastVotes = null;
    ui.bubbles = {};
    ui.log = [];
    ui.freshQuest = null;
    ui.speak = { accuse: '', trust: '' };
    ui.dockHtml = '';
    ui.game.eventsFor(HUMAN).forEach(onEvent);
    $('ending').hidden = true;
    $('btn-identity').hidden = false;
    render();
    showIdentity(true);
  }

  function perform(pid, action) {
    const evs = ui.game.act(pid, action);
    AI.feed(ui.bots, evs);
    evs.forEach((ev) => {
      if (ev.to === null || ev.to.includes(HUMAN)) onEvent(ev);
    });
  }

  function speed() {
    return Number(ui.settings.speed) || 1;
  }

  function schedule() {
    clearTimeout(ui.timer);
    render();
    const g = ui.game;
    if (!g) return;
    if (g.phase === 'over') {
      ui.timer = setTimeout(showEnding, 900);
      return;
    }
    const ai = g.pendingActors().filter((id) => ui.bots[id]);
    if (!ai.length) return; // 等待人类操作
    ui.timer = setTimeout(() => {
      const simultaneous = g.phase === 'vote' || g.phase === 'quest';
      try {
        (simultaneous ? ai : ai.slice(0, 1)).forEach((id) => {
          perform(id, ui.bots[id].decide(g.viewFor(id)));
        });
      } catch (err) {
        console.error(err);
        $('dock').innerHTML = `<p class="dock-prompt">AI 出错了：${esc(err.message)}。请开始新游戏。</p>`;
        ui.dockHtml = '';
        return;
      }
      schedule();
    }, DELAY[g.phase] * speed());
  }

  function humanAct(action) {
    try {
      perform(HUMAN, action);
    } catch (err) {
      flash(err.message);
      return;
    }
    ui.selection.clear();
    ui.target = null;
    schedule();
  }

  function flash(msg) {
    const hint = $('dock').querySelector('.dock-hint');
    if (hint) hint.textContent = msg;
  }

  // ---------- 事件 → 编年史 ----------
  function addLog(cls, html) {
    ui.log.push({ cls, html });
  }

  function onEvent(ev) {
    const g = ui.game;
    switch (ev.type) {
      case 'start': {
        const roles = Array.from(new Set(ev.roleKeys)).map(roleName).join('、');
        addLog('round', `<span class="numeral">I</span> 第一轮`);
        addLog('sys', `${g.n} 名骑士入座，其中 ${ev.numEvil} 名是坏人。本局角色：${roles}。`);
        if (ev.ladyHolder !== null) addLog('sys', `湖中仙女交给了 ${who(ev.ladyHolder)}。`);
        break;
      }
      case 'proposal':
        ui.lastVotes = null;
        addLog('', `第 ${ev.attempt + 1} 次组队：队长 ${who(ev.leader)} 提议 ${list(ev.team)} 出征。`);
        break;
      case 'votes': {
        ui.lastVotes = ev;
        const yes = ev.votes.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
        const no = ev.votes.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
        const verdict = ev.approved ? '<b>组队通过</b>' : '<b>组队被否决</b>';
        addLog('sys', `${verdict}（${yes.length} : ${no.length}）。赞成：${yes.length ? list(yes) : '无'}；反对：${no.length ? list(no) : '无'}。`);
        if (!ev.approved && ev.attempt === 3) addLog('lose', '已连续否决四次。下一次组队若再被否决，坏人直接获胜。');
        break;
      }
      case 'quest':
        ui.freshQuest = ev.round;
        addLog(ev.success ? 'win big' : 'lose big',
          `任务 ${ROMAN[ev.round]} ${ev.success ? '成功' : '失败'}：${ev.fails} 张失败票${ev.required === 2 ? '（本次需要两张才算失败）' : ''}。`);
        break;
      case 'lady':
        addLog('sys', `${who(ev.holder)} 用湖中仙女查验了 ${who(ev.target)}。`);
        break;
      case 'ladyResult':
        addLog('secret', `只有你知道：${who(ev.target)} 是<b>${ev.isEvil ? '坏人' : '好人'}</b>。`);
        break;
      case 'ladyClaim':
        if (ev.claim === null) addLog('sys', `${who(ev.holder)} 没有公布查验结果。`);
        else addLog('say', `<span class="who">${esc(nameOf(ev.holder))}</span>：我查验了 ${esc(nameOf(ev.target))}，结果是<b>${ev.claim === 'evil' ? '坏人' : '好人'}</b>。`);
        break;
      case 'discussStart':
        ui.bubbles = {};
        addLog('sys', '圆桌讨论开始。');
        break;
      case 'speech':
        ui.bubbles[ev.speaker] = ev.text;
        addLog('say', `<span class="who">${esc(nameOf(ev.speaker))}</span>：${esc(ev.text)}`);
        break;
      case 'round':
        ui.lastVotes = null;
        addLog('round', `<span class="numeral">${ROMAN[ev.round]}</span> 第${CN_NUM[ev.round]}轮`);
        break;
      case 'assassinPhase':
        addLog('big', `好人完成了三次任务！刺客 ${who(ev.assassin)} 现身，准备刺杀梅林。`);
        break;
      case 'assassination':
        addLog(ev.success ? 'lose big' : 'win big',
          `刺客 ${who(ev.assassin)} 刺向 ${who(ev.target)}：${ev.success ? '正中梅林！' : `${esc(nameOf(ev.target))} 不是梅林。`}`);
        break;
      case 'end':
        addLog(ev.winner === 'good' ? 'win big' : 'lose big', `${ev.winner === 'good' ? '正义' : '邪恶'}阵营获胜：${esc(ev.reason)}。`);
        break;
      default:
        break;
    }
  }

  // ---------- 渲染 ----------
  function render() {
    if (!ui.game) return;
    const v = ui.game.viewFor(HUMAN);
    renderStatus(v);
    renderTable(v);
    renderDock(v);
    renderLog();
    if (ui.tab === 'votes') renderLedger(v);
    ui.freshQuest = null;
  }

  function renderStatus(v) {
    let s;
    if (v.phase === 'over') s = `对局结束 · <b>${v.winner === 'good' ? '正义' : '邪恶'}阵营获胜</b>`;
    else if (v.phase === 'assassinate') s = '<b>刺杀阶段</b> · 刺客正在寻找梅林';
    else s = `第${CN_NUM[v.round]}轮 · 第 ${v.attempt + 1} 次组队 · 队长 <b>${esc(nameOf(v.leader))}</b> · 任务 ${v.successes} 成 ${v.fails} 败`;
    $('status').innerHTML = s;
  }

  function seatSelectable(v, id) {
    if (!v.pending.includes(HUMAN)) return false;
    if (v.phase === 'propose') return true;
    if (v.phase === 'lady') return id !== HUMAN && !v.lady.used.includes(id);
    if (v.phase === 'assassinate') return id !== HUMAN && !v.evilReveal.some((x) => x.id === id);
    return false;
  }

  function knowledgeTags(v, id) {
    const tags = [];
    if (v.revealed) {
      const r = v.revealed[id];
      tags.push(`<span class="tag role-${teamOf(r)}">${roleName(r)}</span>`);
      return tags;
    }
    if (id === HUMAN) {
      tags.push(`<span class="tag ${v.myTeam}">${roleName(v.myRole)}</span>`);
      return tags;
    }
    if (v.evilReveal) {
      const e = v.evilReveal.find((x) => x.id === id);
      if (e) tags.push(`<span class="tag evil">${roleName(e.role)}</span>`);
    } else {
      v.knowledge.filter((k) => k.id === id).forEach((k) => {
        if (k.tag === 'evil') tags.push(`<span class="tag evil">${v.myTeam === 'evil' ? '同伴' : '坏人'}</span>`);
        else tags.push('<span class="tag unsure">梅林?</span>');
      });
    }
    v.ladyResults.filter((r) => r.target === id).forEach((r) => {
      tags.push(`<span class="tag ${r.isEvil ? 'evil' : 'good'}">验：${r.isEvil ? '坏人' : '好人'}</span>`);
    });
    return tags;
  }

  function seatStatus(v, id) {
    const pending = v.pending.includes(id);
    switch (v.phase) {
      case 'propose':
        if (ui.lastVotes) return ui.lastVotes.votes[id] ? '<span class="chip yes">赞成</span>' : '<span class="chip no">反对</span>';
        return pending && id !== HUMAN ? '组队中' : '';
      case 'vote':
        if (pending) return id === HUMAN ? '等待你投票' : '投票中';
        return '已投票';
      case 'quest':
        if (ui.lastVotes) {
          const chip = ui.lastVotes.votes[id] ? '<span class="chip yes">赞成</span>' : '<span class="chip no">反对</span>';
          if (!v.team.includes(id)) return chip;
          return `${chip} ${pending ? '执行任务' : '已出牌'}`;
        }
        return '';
      case 'lady':
      case 'ladyClaim':
        return pending && id !== HUMAN ? '使用湖中仙女' : '';
      case 'discuss':
        return pending && id !== HUMAN ? '发言中' : '';
      case 'assassinate':
        return pending && id !== HUMAN ? '寻找梅林' : '';
      default:
        return '';
    }
  }

  function renderTable(v) {
    const n = v.n;
    let html = '';
    for (let id = 0; id < n; id++) {
      // 0 号（你）坐在正下方，座位顺时针排列
      const angle = ((90 + (id * 360) / n) * Math.PI) / 180;
      const x = 50 + 41 * Math.cos(angle);
      const y = 50 + 40 * Math.sin(angle);
      const cls = ['seat'];
      if (id === HUMAN) cls.push('me');
      if (v.team && v.team.includes(id) && v.phase !== 'propose') cls.push('on-team');
      const selectable = seatSelectable(v, id);
      if (selectable) cls.push('selectable');
      if (ui.selection.has(id)) cls.push('selected');
      if (ui.target === id) cls.push(v.phase === 'assassinate' ? 'targeted' : 'selected');
      if ((v.phase === 'lady' || v.phase === 'assassinate') && v.pending.includes(HUMAN) && !selectable && id !== HUMAN) cls.push('dim');
      const pending = v.pending.includes(id) && id !== HUMAN && v.phase !== 'over';
      if (pending) cls.push('thinking');
      const tags = [];
      if (v.leader === id && v.phase !== 'over') tags.push('<span class="tag leader">队长</span>');
      if (v.lady && v.lady.holder === id) tags.push('<span class="tag lady">湖中仙女</span>');
      tags.push(...knowledgeTags(v, id));
      const say = ui.bubbles[id] ? `<span class="seat-say">“${esc(ui.bubbles[id])}”</span>` : '';
      const label = `${id + 1} 号 ${nameOf(id)}`;
      html += `<button type="button" class="${cls.join(' ')}" data-seat="${id}" style="--x:${x.toFixed(2)}%;--y:${y.toFixed(2)}%"`
        + ` aria-label="${esc(label)}"${selectable ? '' : ' tabindex="-1"'} aria-pressed="${ui.selection.has(id) || ui.target === id}">`
        + `<span class="seat-head"><span class="seat-no">${id + 1}</span><span class="seat-name">${esc(nameOf(id))}</span></span>`
        + `<span class="seat-tags">${tags.join('')}</span>`
        + `<span class="seat-status">${seatStatus(v, id)}</span>`
        + `${say}</button>`;
    }
    html += `<div class="table-center" id="table-center">${renderCenter(v)}</div>`;
    $('table').innerHTML = html;
  }

  function renderCenter(v) {
    const sizes = A.TEAM_SIZES[v.n];
    let medals = '';
    for (let r = 0; r < 5; r++) {
      const q = v.quests[r];
      const cls = ['medal'];
      let note = '';
      if (q) {
        cls.push(q.success ? 'win' : 'lose');
        note = q.fails ? `${q.fails} 败` : '全胜';
      } else if (r === v.round && v.phase !== 'over') {
        cls.push('current');
      }
      if (!q && A.requiredFails(v.n, r) === 2) note = '需两败';
      if (ui.freshQuest === r) cls.push('fresh');
      medals += `<div class="${cls.join(' ')}" title="任务 ${ROMAN[r]}：${sizes[r]} 人">`
        + `<span class="medal-no">${ROMAN[r]}</span><span class="medal-size">${sizes[r]}</span>`
        + `${note ? `<span class="medal-note">${note}</span>` : ''}</div>`;
    }
    let pips = '';
    for (let i = 0; i < 5; i++) {
      pips += `<span class="pip${i < v.attempt ? ' used' : ''}${i === 4 ? ' doom' : ''}"></span>`;
    }
    return `<div class="quests">${medals}</div>`
      + '<div class="table-caption">徽章数字为出征人数</div>'
      + `<div class="track"><span>否决</span>${pips}</div>`;
  }

  function teamLine(v) {
    return list(v.team);
  }

  function renderDock(v) {
    const mine = v.pending.includes(HUMAN);
    let prompt = '';
    let hint = '';
    let actions = '';
    let secret = '';
    switch (v.phase) {
      case 'propose':
        if (mine) {
          const k = ui.selection.size;
          prompt = `你是队长。请点击座位，挑选 <b>${v.teamSize}</b> 名队员出征（已选 ${k}/${v.teamSize}）。`;
          hint = v.requiredFails === 2 ? '本次任务需要两张失败票才会失败。' : '通常队长会把自己放进队伍。';
          if (v.attempt === 4) hint = '这是本轮第五次组队，若再被否决坏人直接获胜。';
          actions = `<button type="button" class="btn primary big" data-act="submit-team"${k === v.teamSize ? '' : ' disabled'}>提交队伍</button>`
            + `<button type="button" class="btn" data-act="clear-team"${k ? '' : ' disabled'}>清空</button>`;
        } else {
          prompt = `队长 ${who(v.leader)} 正在挑选 ${v.teamSize} 名队员…`;
        }
        break;
      case 'vote':
        if (mine) {
          prompt = `队长 ${who(v.leader)} 提议由 ${teamLine(v)} 出征。你同意吗？`;
          hint = v.attempt === 4 ? '这是本轮第五次组队：若被否决，坏人直接获胜。' : `超过半数（至少 ${Math.floor(v.n / 2) + 1} 票）赞成才能通过。`;
          actions = '<button type="button" class="btn good big" data-act="approve">赞成</button>'
            + '<button type="button" class="btn evil big" data-act="reject">反对</button>';
        } else {
          prompt = `你投了<b>${v.myVote ? '赞成' : '反对'}</b>，等待其他人投票…`;
        }
        break;
      case 'quest':
        if (mine) {
          prompt = `你在任务 ${ROMAN[v.round]} 的队伍中。请暗中选择任务牌：`;
          hint = v.myTeam === 'good' ? '好人只能出成功票。' : (v.requiredFails === 2 ? '本次任务需要两张失败票才会失败。' : '一张失败票就能让任务失败。');
          actions = '<button type="button" class="btn good big" data-act="success">成功</button>'
            + `<button type="button" class="btn evil big" data-act="fail"${v.myTeam === 'good' ? ' disabled' : ''}>失败</button>`;
        } else if (v.team.includes(HUMAN)) {
          prompt = '你已出牌，等待其他队员…';
        } else {
          prompt = `${teamLine(v)} 正在执行任务 ${ROMAN[v.round]}…`;
        }
        break;
      case 'lady':
        if (mine) {
          prompt = '你持有湖中仙女。点击一名玩家，查验其阵营。';
          hint = '不能查验曾经持有过湖中仙女的人。查验后湖中仙女交给对方。';
          actions = `<button type="button" class="btn primary big" data-act="lady"${ui.target === null ? ' disabled' : ''}>查验${ui.target === null ? '' : ` ${esc(nameOf(ui.target))}`}</button>`;
        } else {
          prompt = `${who(v.lady.holder)} 正在使用湖中仙女…`;
        }
        break;
      case 'ladyClaim':
        if (mine) {
          const r = v.ladyPending;
          secret = `<p class="dock-secret">查验结果（只有你知道）：${who(r.target)} 是<b>${r.isEvil ? '坏人' : '好人'}</b>。</p>`;
          prompt = '要向大家公布吗？你也可以说谎。';
          actions = '<button type="button" class="btn good" data-act="claim-good">宣布是好人</button>'
            + '<button type="button" class="btn evil" data-act="claim-evil">宣布是坏人</button>'
            + '<button type="button" class="btn" data-act="claim-none">不公布</button>';
        } else {
          prompt = '湖中仙女持有者正在决定是否公布结果…';
        }
        break;
      case 'discuss':
        if (mine) {
          const opts = (sel) => ['<option value="">——</option>']
            .concat(v.players.filter((p) => p.id !== HUMAN).map((p) => `<option value="${p.id}"${String(p.id) === sel ? ' selected' : ''}>${p.id + 1} 号 ${esc(p.name)}</option>`))
            .join('');
          prompt = '轮到你发言。AI 会参考你的怀疑和信任。';
          actions = '<div class="speak-row">'
            + `<label for="speak-accuse">怀疑<select id="speak-accuse">${opts(ui.speak.accuse)}</select></label>`
            + `<label for="speak-trust">信任<select id="speak-trust">${opts(ui.speak.trust)}</select></label>`
            + '</div>'
            + '<button type="button" class="btn primary" data-act="speak">发言</button>'
            + '<button type="button" class="btn" data-act="pass">跳过</button>';
        } else {
          prompt = `${who(v.pending[0])} 正在发言…`;
        }
        break;
      case 'assassinate':
        if (mine) {
          const mates = v.evilReveal.filter((x) => x.id !== HUMAN).map((x) => `${esc(nameOf(x.id))}（${roleName(x.role)}）`).join('、');
          prompt = '好人完成了三次任务。你是刺客：点击你认为是梅林的玩家。';
          hint = `你的同伴：${mates || '无'}。刺中梅林，坏人翻盘。`;
          actions = `<button type="button" class="btn evil big" data-act="assassinate"${ui.target === null ? ' disabled' : ''}>刺杀${ui.target === null ? '' : ` ${esc(nameOf(ui.target))}`}</button>`;
        } else {
          prompt = `刺客 ${who(v.pending[0])} 正在寻找梅林…`;
        }
        break;
      case 'over': {
        const won = v.winner === v.myTeam;
        prompt = `<b>${v.winner === 'good' ? '正义' : '邪恶'}阵营获胜</b>：${esc(v.endReason)}。${won ? '你赢了！' : '你输了。'}`;
        actions = '<button type="button" class="btn primary" data-act="ending">查看结局</button>'
          + '<button type="button" class="btn" data-act="again">再来一局</button>';
        break;
      }
      default:
        break;
    }
    const html = `${secret}<p class="dock-prompt">${prompt}</p>`
      + `<p class="dock-hint"${hint ? '' : ' hidden'}>${hint}</p>`
      + (actions ? `<div class="dock-actions">${actions}</div>` : '');
    // 内容未变时不重绘，避免打断下拉框等交互
    if (html !== ui.dockHtml) {
      $('dock').innerHTML = html;
      ui.dockHtml = html;
    }
  }

  function renderLog() {
    const el = $('log');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (el.children.length > ui.log.length) el.innerHTML = '';
    for (let i = el.children.length; i < ui.log.length; i++) {
      const li = document.createElement('li');
      li.className = ui.log[i].cls;
      li.innerHTML = ui.log[i].html;
      el.appendChild(li);
    }
    if (atBottom || ui.log.length < 6) el.scrollTop = el.scrollHeight;
  }

  function renderLedger(v) {
    const wrap = $('ledger');
    if (!v.proposals.length) {
      wrap.innerHTML = '<p class="ledger-empty">还没有完成的投票。</p>';
      return;
    }
    let head = '<tr><th>轮</th><th>队长</th>';
    for (let i = 0; i < v.n; i++) head += `<th class="${i === HUMAN ? 'me' : ''}" title="${esc(nameOf(i))}">${i + 1}</th>`;
    head += '<th>结果</th></tr>';
    let body = '';
    let lastRound = -1;
    v.proposals.forEach((p) => {
      if (p.round !== lastRound && lastRound >= 0) {
        const q = v.quests[lastRound];
        if (q) body += `<tr class="quest-row"><td colspan="${v.n + 3}" class="${q.success ? 'res-ok' : 'res-no'}">任务 ${ROMAN[q.round]}：${q.success ? '成功' : '失败'}（${q.fails} 张失败票）</td></tr>`;
      }
      lastRound = p.round;
      body += `<tr><td>${ROMAN[p.round]}-${p.attempt + 1}</td><td>${p.leader + 1}</td>`;
      p.votes.forEach((yes, i) => {
        const cls = [yes ? 'yes' : 'no'];
        if (p.team.includes(i)) cls.push('on');
        if (p.leader === i) cls.push('lead');
        body += `<td class="${cls.join(' ')}">${yes ? '✓' : '✗'}</td>`;
      });
      body += `<td class="${p.approved ? 'res-ok' : 'res-no'}">${p.approved ? '通过' : '否决'}</td></tr>`;
    });
    const q = v.quests[lastRound];
    if (q) body += `<tr class="quest-row"><td colspan="${v.n + 3}" class="${q.success ? 'res-ok' : 'res-no'}">任务 ${ROMAN[q.round]}：${q.success ? '成功' : '失败'}（${q.fails} 张失败票）</td></tr>`;
    const names = v.players.map((p) => `${p.id + 1} ${p.human ? '你' : p.name}`).join(' · ');
    wrap.innerHTML = `<table class="ledger"><thead>${head}</thead><tbody>${body}</tbody></table>`
      + `<p class="ledger-legend">底色 = 出征队员，金框 = 队长。${esc(names)}</p>`;
  }

  // ---------- 浮层 ----------
  function intelHtml(v) {
    const role = v.myRole;
    const k = v.knowledge;
    const ids = (tag) => k.filter((x) => x.tag === tag).map((x) => x.id);
    const names = (arr) => arr.map((id) => `${id + 1} 号 ${esc(nameOf(id))}`).join('、');
    const lines = [];
    if (role === 'merlin') {
      lines.push(`<p>坏人：<span class="evil">${names(ids('evil'))}</span></p>`);
      if (v.roleKeys.includes('mordred')) lines.push('<p class="small">莫德雷德藏在其余人中，你看不到他。</p>');
    } else if (role === 'percival') {
      const c = ids('merlinOrMorgana');
      if (c.length === 2) lines.push(`<p>梅林和莫甘娜就在这两人中：<span class="unsure">${names(c)}</span></p>`);
      else lines.push(`<p>梅林是：<span class="unsure">${names(c)}</span></p>`);
    } else if (v.myTeam === 'evil' && role !== 'oberon') {
      const mates = ids('evil');
      lines.push(`<p>你的坏人同伴：<span class="evil">${mates.length ? names(mates) : '无'}</span></p>`);
      if (v.roleKeys.includes('oberon')) lines.push('<p class="small">奥伯伦也是坏人，但你们互不相识。</p>');
    } else if (role === 'oberon') {
      lines.push('<p>你不认识其他坏人，他们也不认识你。</p>');
    } else {
      lines.push('<p>你没有额外情报，只能靠推理。</p>');
    }
    return lines.join('');
  }

  function showIdentity(first) {
    const v = ui.game.viewFor(HUMAN);
    const team = v.myTeam;
    $('identity-card').innerHTML = '<p class="eyebrow">你的身份牌</p>'
      + `<div><h2 class="role-name ${team}">${roleName(v.myRole)}</h2>`
      + `<p class="team-line">${team === 'good' ? '正义阵营 · 亚瑟的骑士' : '邪恶阵营 · 莫德雷德的爪牙'} · 坐在 1 号位</p></div>`
      + `<p class="role-desc">${A.ROLES[v.myRole].desc}</p>`
      + `<div class="intel"><h3>你掌握的情报</h3>${intelHtml(v)}</div>`
      + `<p class="small">本局角色：${Array.from(new Set(v.roleKeys)).map(roleName).join('、')}。</p>`
      + `<div class="sheet-actions"><button type="button" class="btn primary big" id="identity-close">${first ? '入席' : '收起'}</button></div>`;
    $('identity').hidden = false;
    $('identity-close').focus();
    $('identity-close').addEventListener('click', () => {
      $('identity').hidden = true;
      if (first) schedule();
    }, { once: true });
  }

  function showEnding() {
    const g = ui.game;
    if (!g || g.phase !== 'over') return;
    const v = g.viewFor(HUMAN);
    const won = v.winner === v.myTeam;
    const items = g.players.map((p) => `<li class="${p.team}"><span>${p.id + 1} 号 ${esc(nameOf(p.id))}</span>`
      + `<span class="r-role ${p.team}">${roleName(p.role)}</span></li>`).join('');
    let detail = '';
    if (v.assassination) {
      detail = `<p class="small">刺客 ${esc(nameOf(v.assassination.assassin))} 指认了 ${esc(nameOf(v.assassination.target))}${v.assassination.success ? '，正是梅林。' : '，但真正的梅林是 ' + esc(nameOf(g.players.find((p) => p.role === 'merlin').id)) + '。'}</p>`;
    }
    $('ending-card').innerHTML = `<p class="eyebrow">${won ? '胜利' : '落败'} · 你是${roleName(v.myRole)}</p>`
      + `<h2 class="verdict ${v.winner}">${v.winner === 'good' ? '正义阵营获胜' : '邪恶阵营获胜'}</h2>`
      + `<p class="role-desc">${esc(v.endReason)}。任务结果：${v.quests.map((q) => (q.success ? '成' : '败')).join(' · ')}</p>`
      + detail
      + `<ul class="reveal">${items}</ul>`
      + '<div class="sheet-actions"><button type="button" class="btn" data-close="ending">查看棋盘</button>'
      + '<button type="button" class="btn primary" id="ending-again">再来一局</button></div>';
    $('ending').hidden = false;
    $('ending-again').addEventListener('click', () => { $('ending').hidden = true; openSetup(); }, { once: true });
  }

  // ---------- 交互 ----------
  function bindGame() {
    $('table').addEventListener('click', (e) => {
      const seat = e.target.closest('[data-seat]');
      if (!seat || !ui.game) return;
      const id = Number(seat.dataset.seat);
      const v = ui.game.viewFor(HUMAN);
      if (!seatSelectable(v, id)) return;
      if (v.phase === 'propose') {
        if (ui.selection.has(id)) ui.selection.delete(id);
        else if (ui.selection.size < v.teamSize) ui.selection.add(id);
        else { flash(`队伍只需要 ${v.teamSize} 人，先取消一名队员。`); return; }
      } else {
        ui.target = ui.target === id ? null : id;
      }
      render();
    });

    $('dock').addEventListener('change', (e) => {
      if (e.target.id === 'speak-accuse') ui.speak.accuse = e.target.value;
      if (e.target.id === 'speak-trust') ui.speak.trust = e.target.value;
    });

    $('dock').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      switch (act) {
        case 'submit-team': humanAct({ type: 'propose', team: Array.from(ui.selection) }); break;
        case 'clear-team': ui.selection.clear(); render(); break;
        case 'approve': humanAct({ type: 'vote', approve: true }); break;
        case 'reject': humanAct({ type: 'vote', approve: false }); break;
        case 'success': humanAct({ type: 'quest', success: true }); break;
        case 'fail': humanAct({ type: 'quest', success: false }); break;
        case 'lady': humanAct({ type: 'lady', target: ui.target }); break;
        case 'claim-good': humanAct({ type: 'ladyClaim', claim: 'good' }); break;
        case 'claim-evil': humanAct({ type: 'ladyClaim', claim: 'evil' }); break;
        case 'claim-none': humanAct({ type: 'ladyClaim', claim: null }); break;
        case 'speak': {
          const accuse = ui.speak.accuse === '' ? null : Number(ui.speak.accuse);
          const trust = ui.speak.trust === '' ? null : Number(ui.speak.trust);
          if (accuse !== null && accuse === trust) { flash('不能同时怀疑和信任同一个人。'); return; }
          const parts = [];
          if (accuse !== null) parts.push(`我怀疑${ui.game.players[accuse].name}`);
          if (trust !== null) parts.push(`我信任${ui.game.players[trust].name}`);
          ui.speak = { accuse: '', trust: '' };
          humanAct({ type: 'speak', accuse, trust, text: parts.length ? `${parts.join('，')}。` : '我先不表态。' });
          break;
        }
        case 'pass':
          ui.speak = { accuse: '', trust: '' };
          humanAct({ type: 'speak', accuse: null, trust: null, text: '我先不表态。' });
          break;
        case 'assassinate': humanAct({ type: 'assassinate', target: ui.target }); break;
        case 'ending': showEnding(); break;
        case 'again': openSetup(); break;
        default: break;
      }
    });

    const setTab = (tab) => {
      ui.tab = tab;
      $('tab-log').setAttribute('aria-selected', String(tab === 'log'));
      $('tab-votes').setAttribute('aria-selected', String(tab === 'votes'));
      $('log').hidden = tab !== 'log';
      $('ledger').hidden = tab !== 'votes';
      if (tab === 'votes' && ui.game) renderLedger(ui.game.viewFor(HUMAN));
      try { window.localStorage.setItem('avalon.tab', tab); } catch (e) { /* 忽略 */ }
    };
    $('tab-log').addEventListener('click', () => setTab('log'));
    $('tab-votes').addEventListener('click', () => setTab('votes'));
    try { if (window.localStorage.getItem('avalon.tab') === 'votes') setTab('votes'); } catch (e) { /* 忽略 */ }

    $('btn-new').addEventListener('click', openSetup);
    $('btn-rules').addEventListener('click', () => { $('rules').hidden = false; });
    $('btn-identity').addEventListener('click', () => { if (ui.game) showIdentity(false); });

    document.addEventListener('click', (e) => {
      const c = e.target.closest('[data-close]');
      if (c) $(c.dataset.close).hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') ['rules', 'ending'].forEach((id) => { $(id).hidden = true; });
    });
  }

  // ---------- 启动 ----------
  function init() {
    const saved = storage.load();
    ui.settings = Object.assign(defaultSettings(), saved || {});
    if (!A.TEAM_SIZES[ui.settings.n]) ui.settings = defaultSettings();
    ui.settings.options = Object.assign(A.defaultOptions(ui.settings.n), (saved && saved.options) || {});
    // 存档与人数不匹配时退回推荐配置
    if (A.validateOptions(ui.settings.n, ui.settings.options).length) ui.settings.options = A.defaultOptions(ui.settings.n);
    bindSetup();
    bindGame();
    renderSetup();
    renderPreview();
  }

  // 开局前在设置面板后方展示空桌，让第一屏就能看到牌桌的样子
  function renderPreview() {
    const n = ui.settings.n;
    const fake = {
      n, phase: 'propose', round: 0, attempt: 0, leader: -1, team: null, quests: [], pending: [],
      lady: null, revealed: null, evilReveal: null, knowledge: [], ladyResults: [], myTeam: 'good', myRole: 'servant',
    };
    let html = '';
    for (let id = 0; id < n; id++) {
      const angle = ((90 + (id * 360) / n) * Math.PI) / 180;
      const x = 50 + 41 * Math.cos(angle);
      const y = 50 + 40 * Math.sin(angle);
      html += `<div class="seat${id === HUMAN ? ' me' : ''}" style="--x:${x.toFixed(2)}%;--y:${y.toFixed(2)}%">`
        + `<span class="seat-head"><span class="seat-no">${id + 1}</span><span class="seat-name">${id === HUMAN ? '你' : '空位'}</span></span></div>`;
    }
    html += `<div class="table-center" id="table-center">${renderCenter(fake)}</div>`;
    $('table').innerHTML = html;
    $('dock').innerHTML = '<p class="dock-prompt">选好人数与角色，点击“入座开局”。</p>';
    $('status').textContent = '等待开局';
  }

  init();
})();
