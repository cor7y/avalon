/* 阿瓦隆游戏引擎：纯规则状态机，不含任何界面或 AI 逻辑。 */
(function (root) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const R = isNode ? require('./rules.js') : root.Avalon;

  // mulberry32：可设定种子的伪随机数，便于复现对局与测试
  function makeRng(seed) {
    let a = seed >>> 0;
    const rng = function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.int = (n) => Math.floor(rng() * n);
    rng.pick = (arr) => arr[rng.int(arr.length)];
    rng.shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };
    return rng;
  }

  const DEFAULT_NAMES = ['高文', '凯', '崔斯坦', '贝狄威尔', '加雷斯', '鲍斯', '伊索德', '莱昂内尔', '埃克托', '艾琳'];
  const ROLE_ORDER = Object.keys(R.ROLES);

  class Game {
    constructor({ n, options, roles, names, humanSeat, rng, seed }) {
      this.n = n;
      this.options = options;
      this.rng = rng;
      this.seed = seed;
      this.numEvil = R.EVIL_COUNT[n];
      this.players = roles.map((role, id) => ({
        id, name: names[id], role, team: R.ROLES[role].team, human: id === humanSeat,
      }));
      this.roleKeys = roles.slice().sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
      this.round = 0;
      this.attempt = 0;
      this.leader = rng.int(n);
      this.team = null;
      this.votes = null;
      this.questCards = null;
      this.quests = [];
      this.proposals = [];
      this.speeches = [];
      this.ladyClaims = [];
      this.lady = null;
      this.ladyPending = null;
      if (options.lady) {
        // 湖中仙女交给首任队长右手边（即上一位）的玩家
        const holder = (this.leader - 1 + n) % n;
        this.lady = { holder, used: [holder], results: [] };
      }
      this.discussOrder = null;
      this.discussIdx = 0;
      this.winner = null;
      this.endReason = null;
      this.assassination = null;
      this.events = [];
      this.phase = 'propose';
      this._emit({
        type: 'start', leader: this.leader, roleKeys: this.roleKeys.slice(), numEvil: this.numEvil,
        ladyHolder: this.lady ? this.lady.holder : null,
      });
    }

    get teamSize() {
      return R.TEAM_SIZES[this.n][Math.min(this.round, 4)];
    }

    get requiredFails() {
      return R.requiredFails(this.n, this.round);
    }

    get successes() {
      return this.quests.filter((q) => q.success).length;
    }

    get fails() {
      return this.quests.filter((q) => !q.success).length;
    }

    get assassinId() {
      const p = this.players.find((x) => x.role === 'assassin');
      return p ? p.id : null;
    }

    _emit(ev, to = null) {
      ev.seq = this.events.length;
      ev.to = to;
      this.events.push(ev);
    }

    // 当前需要行动的玩家 id 列表
    pendingActors() {
      switch (this.phase) {
        case 'propose': return [this.leader];
        case 'vote': return this.votes.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
        case 'quest': return this.team.filter((id) => !(id in this.questCards));
        case 'lady': return [this.lady.holder];
        case 'ladyClaim': return [this.ladyPending.holder];
        case 'discuss': return [this.discussOrder[this.discussIdx]];
        case 'assassinate': return [this.assassinId];
        default: return [];
      }
    }

    // 执行一个玩家动作，返回由此产生的新事件；非法动作抛出异常
    act(pid, action) {
      if (this.phase === 'over') throw new Error('游戏已经结束');
      if (!this.pendingActors().includes(pid)) throw new Error(`现在不是 ${pid} 号玩家行动的时候`);
      const expected = {
        propose: 'propose', vote: 'vote', quest: 'quest', lady: 'lady',
        ladyClaim: 'ladyClaim', discuss: 'speak', assassinate: 'assassinate',
      }[this.phase];
      if (!action || action.type !== expected) throw new Error(`当前阶段需要 ${expected} 动作`);
      const start = this.events.length;
      switch (this.phase) {
        case 'propose': this._propose(pid, action.team); break;
        case 'vote': this._vote(pid, action.approve); break;
        case 'quest': this._quest(pid, action.success); break;
        case 'lady': this._lady(pid, action.target); break;
        case 'ladyClaim': this._ladyClaim(pid, action.claim); break;
        case 'discuss': this._speak(pid, action); break;
        case 'assassinate': this._assassinate(pid, action.target); break;
      }
      return this.events.slice(start);
    }

    _isPlayer(id) {
      return Number.isInteger(id) && id >= 0 && id < this.n;
    }

    _propose(pid, team) {
      if (!Array.isArray(team)) throw new Error('队伍必须是玩家列表');
      const uniq = Array.from(new Set(team));
      if (uniq.length !== team.length || !uniq.every((id) => this._isPlayer(id))) throw new Error('队伍成员无效');
      if (uniq.length !== this.teamSize) throw new Error(`本轮任务需要 ${this.teamSize} 人`);
      this.team = uniq.sort((a, b) => a - b);
      this.votes = new Array(this.n).fill(null);
      this.phase = 'vote';
      this._emit({ type: 'proposal', round: this.round, attempt: this.attempt, leader: pid, team: this.team.slice() });
    }

    _vote(pid, approve) {
      if (typeof approve !== 'boolean') throw new Error('投票必须是赞成或反对');
      this.votes[pid] = approve;
      if (this.votes.some((v) => v === null)) return;
      const approvals = this.votes.filter(Boolean).length;
      const approved = approvals * 2 > this.n;
      const rec = {
        round: this.round, attempt: this.attempt, leader: this.leader,
        team: this.team.slice(), votes: this.votes.slice(), approved,
      };
      this.proposals.push(rec);
      this._emit(Object.assign({ type: 'votes' }, rec, { team: rec.team.slice(), votes: rec.votes.slice() }));
      this.votes = null;
      if (approved) {
        this.questCards = {};
        this.phase = 'quest';
        return;
      }
      this.attempt += 1;
      if (this.attempt >= 5) {
        this._end('evil', '连续五次组队被否决');
        return;
      }
      this.leader = (this.leader + 1) % this.n;
      this.team = null;
      this.phase = 'propose';
    }

    _quest(pid, success) {
      if (typeof success !== 'boolean') throw new Error('任务牌必须是成功或失败');
      if (!success && this.players[pid].team === 'good') throw new Error('好人只能出成功票');
      this.questCards[pid] = success;
      if (this.team.some((id) => !(id in this.questCards))) return;
      const fails = this.team.filter((id) => !this.questCards[id]).length;
      const required = this.requiredFails;
      const q = { round: this.round, leader: this.leader, team: this.team.slice(), fails, required, success: fails < required };
      this.quests.push(q);
      this.questCards = null;
      this._emit(Object.assign({ type: 'quest' }, q, { team: q.team.slice() }));
      if (this.fails >= 3) {
        this._end('evil', '三次任务失败');
        return;
      }
      if (this.successes >= 3) {
        if (this.assassinId !== null) {
          this.phase = 'assassinate';
          this._emit({ type: 'assassinPhase', assassin: this.assassinId });
        } else {
          this._end('good', '三次任务成功');
        }
        return;
      }
      // 湖中仙女在第 2、3、4 个任务结束后使用
      if (this.lady && this.round >= 1 && this.round <= 3) {
        this.phase = 'lady';
        return;
      }
      this._startDiscussion();
    }

    _lady(pid, target) {
      if (!this._isPlayer(target) || target === pid) throw new Error('查验对象无效');
      if (this.lady.used.includes(target)) throw new Error('不能查验曾经持有湖中仙女的玩家');
      const isEvil = this.players[target].team === 'evil';
      this.lady.used.push(target);
      this.lady.results.push({ round: this.round, holder: pid, target, isEvil });
      this.lady.holder = target;
      this.ladyPending = { holder: pid, target, isEvil };
      this.phase = 'ladyClaim';
      this._emit({ type: 'lady', round: this.round, holder: pid, target });
      this._emit({ type: 'ladyResult', round: this.round, holder: pid, target, isEvil }, [pid]);
    }

    _ladyClaim(pid, claim) {
      if (claim !== 'good' && claim !== 'evil' && claim !== null) throw new Error('声明必须是好人、坏人或不公开');
      const { target } = this.ladyPending;
      const rec = { round: this.round, holder: pid, target, claim };
      this.ladyClaims.push(rec);
      this.ladyPending = null;
      this._emit(Object.assign({ type: 'ladyClaim' }, rec));
      this._startDiscussion();
    }

    _startDiscussion() {
      const first = (this.leader + 1) % this.n;
      this.discussOrder = [];
      for (let i = 0; i < this.n; i++) this.discussOrder.push((first + i) % this.n);
      this.discussIdx = 0;
      this.phase = 'discuss';
      this._emit({ type: 'discussStart', round: this.round });
    }

    _speak(pid, { accuse = null, trust = null, text = '' }) {
      for (const id of [accuse, trust]) {
        if (id !== null && (!this._isPlayer(id) || id === pid)) throw new Error('发言对象无效');
      }
      if (accuse !== null && accuse === trust) throw new Error('不能同时怀疑和信任同一个人');
      const rec = { round: this.round, speaker: pid, accuse, trust, text: String(text).slice(0, 120) };
      this.speeches.push(rec);
      this._emit(Object.assign({ type: 'speech' }, rec));
      this.discussIdx += 1;
      if (this.discussIdx >= this.discussOrder.length) this._nextRound();
    }

    _nextRound() {
      this.round += 1;
      this.attempt = 0;
      this.leader = (this.leader + 1) % this.n;
      this.team = null;
      this.discussOrder = null;
      this.phase = 'propose';
      this._emit({ type: 'round', round: this.round, leader: this.leader });
    }

    _assassinate(pid, target) {
      if (!this._isPlayer(target) || target === pid) throw new Error('刺杀对象无效');
      const success = this.players[target].role === 'merlin';
      this.assassination = { assassin: pid, target, success };
      this._emit({ type: 'assassination', assassin: pid, target, success });
      if (success) this._end('evil', '刺客刺中了梅林');
      else this._end('good', '三次任务成功，刺客没能找到梅林');
    }

    _end(winner, reason) {
      this.winner = winner;
      this.endReason = reason;
      this.phase = 'over';
      this._emit({ type: 'end', winner, reason, roles: this.players.map((p) => p.role) });
    }

    // 夜晚阶段每个玩家获得的信息
    knowledgeFor(pid) {
      const me = this.players[pid];
      const out = [];
      if (me.role === 'merlin') {
        this.players.forEach((p) => {
          if (p.team === 'evil' && p.role !== 'mordred') out.push({ id: p.id, tag: 'evil' });
        });
      } else if (me.role === 'percival') {
        this.players.forEach((p) => {
          if (p.role === 'merlin' || p.role === 'morgana') out.push({ id: p.id, tag: 'merlinOrMorgana' });
        });
      } else if (me.team === 'evil' && me.role !== 'oberon') {
        this.players.forEach((p) => {
          if (p.id !== pid && p.team === 'evil' && p.role !== 'oberon') out.push({ id: p.id, tag: 'evil' });
        });
      }
      return out;
    }

    // 某位玩家视角下的局面：只包含该玩家有权知道的信息
    viewFor(pid) {
      const me = this.players[pid];
      const over = this.phase === 'over';
      const evilConfer = (this.phase === 'assassinate' || over) && me.team === 'evil';
      const copy = (x) => JSON.parse(JSON.stringify(x));
      return {
        me: pid,
        n: this.n,
        numEvil: this.numEvil,
        myRole: me.role,
        myTeam: me.team,
        roleKeys: this.roleKeys.slice(),
        players: this.players.map((p) => ({ id: p.id, name: p.name, human: p.human })),
        knowledge: this.knowledgeFor(pid),
        ladyResults: this.lady ? copy(this.lady.results.filter((r) => r.holder === pid)) : [],
        phase: this.phase,
        round: this.round,
        attempt: this.attempt,
        leader: this.leader,
        team: this.team ? this.team.slice() : null,
        teamSize: this.teamSize,
        requiredFails: this.requiredFails,
        successes: this.successes,
        fails: this.fails,
        quests: copy(this.quests),
        proposals: copy(this.proposals),
        speeches: copy(this.speeches),
        ladyClaims: copy(this.ladyClaims),
        lady: this.lady ? { holder: this.lady.holder, used: this.lady.used.slice() } : null,
        ladyPending: this.ladyPending && this.ladyPending.holder === pid ? copy(this.ladyPending) : null,
        pending: this.pendingActors(),
        myVote: this.phase === 'vote' ? this.votes[pid] : null,
        myQuestCard: this.phase === 'quest' && pid in this.questCards ? this.questCards[pid] : null,
        // 刺杀阶段坏人可以互相确认身份
        evilReveal: evilConfer ? this.players.filter((p) => p.team === 'evil').map((p) => ({ id: p.id, role: p.role })) : null,
        revealed: over ? this.players.map((p) => p.role) : null,
        winner: this.winner,
        endReason: this.endReason,
        assassination: this.assassination ? copy(this.assassination) : null,
      };
    }

    eventsFor(pid, fromSeq = 0) {
      return this.events.slice(fromSeq).filter((ev) => ev.to === null || ev.to.includes(pid));
    }
  }

  // opts: { numPlayers, options, humanSeat, humanRole, humanName, names, seed }
  function createGame(opts = {}) {
    const n = opts.numPlayers || 5;
    const options = Object.assign(R.defaultOptions(n), opts.options || {});
    const seed = opts.seed !== undefined ? opts.seed >>> 0 : Math.floor(Math.random() * 4294967296);
    const rng = makeRng(seed);
    const roles = rng.shuffle(R.buildRoleList(n, options));
    const humanSeat = opts.humanSeat === undefined ? null : opts.humanSeat;
    if (humanSeat !== null && opts.humanRole && opts.humanRole !== 'random') {
      const idx = roles.indexOf(opts.humanRole);
      if (idx < 0) throw new Error(`本局配置中没有角色：${R.ROLES[opts.humanRole] ? R.ROLES[opts.humanRole].name : opts.humanRole}`);
      [roles[idx], roles[humanSeat]] = [roles[humanSeat], roles[idx]];
    }
    let names = opts.names;
    if (!names) {
      const pool = rng.shuffle(DEFAULT_NAMES.slice());
      names = [];
      for (let i = 0; i < n; i++) names.push(i === humanSeat ? (opts.humanName || '你') : pool.pop());
    }
    return new Game({ n, options, roles, names, humanSeat, rng, seed });
  }

  const api = { makeRng, createGame, Game, DEFAULT_NAMES };
  if (isNode) module.exports = api;
  else Object.assign((root.Avalon = root.Avalon || {}), api);
})(typeof window !== 'undefined' ? window : globalThis);
