/*
 * 阿瓦隆 AI。
 * 每个 AI 枚举"谁是坏人"的所有可能组合（最多 C(10,4)=210 种），
 * 根据组队、投票、任务结果、发言与湖中仙女声明做贝叶斯更新，再按角色策略行动。
 * AI 只读取 game.viewFor(自己) 与自己可见的事件，不会偷看隐藏信息。
 */
(function (root) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const E = isNode ? require('./engine.js') : root.Avalon;

  // ---------- 位运算工具 ----------
  function combos(n, k) {
    const out = [];
    const rec = (start, left, mask) => {
      if (left === 0) { out.push(mask); return; }
      for (let i = start; i <= n - left; i++) rec(i + 1, left - 1, mask | (1 << i));
    };
    rec(0, k, 0);
    return out;
  }
  function popcount(x) {
    let c = 0;
    while (x) { x &= x - 1; c++; }
    return c;
  }
  function toMask(ids) {
    return ids.reduce((m, i) => m | (1 << i), 0);
  }
  function fromMask(mask, n) {
    const out = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) out.push(i);
    return out;
  }
  const has = (mask, i) => (mask & (1 << i)) !== 0;

  const teamCache = new Map();
  function allTeams(n, size) {
    const key = n * 100 + size;
    if (!teamCache.has(key)) teamCache.set(key, combos(n, size));
    return teamCache.get(key);
  }

  // ---------- 信念模型 ----------
  class Belief {
    constructor(n, numEvil, filter) {
      this.n = n;
      this.worlds = combos(n, numEvil).filter(filter);
      this.logw = new Float64Array(this.worlds.length);
      this._p = null;
    }

    // 每个世界的权重乘以 fn(世界)^temper；若证据与所有世界矛盾则忽略
    update(fn, temper = 1) {
      const next = new Float64Array(this.logw.length);
      let alive = 0;
      for (let i = 0; i < this.worlds.length; i++) {
        const l = this.logw[i] === -Infinity ? 0 : fn(this.worlds[i]);
        next[i] = l > 0 ? this.logw[i] + temper * Math.log(l) : -Infinity;
        if (next[i] > -Infinity) alive++;
      }
      if (alive === 0) return false;
      this.logw = next;
      this._p = null;
      return true;
    }

    probs() {
      if (this._p) return this._p;
      let max = -Infinity;
      for (const l of this.logw) if (l > max) max = l;
      const p = new Float64Array(this.logw.length);
      let sum = 0;
      for (let i = 0; i < p.length; i++) { p[i] = Math.exp(this.logw[i] - max); sum += p[i]; }
      for (let i = 0; i < p.length; i++) p[i] /= sum;
      this._p = p;
      return p;
    }

    pEvil(id) {
      const p = this.probs();
      let s = 0;
      for (let i = 0; i < p.length; i++) if (has(this.worlds[i], id)) s += p[i];
      return s;
    }

    pClean(teamMask) {
      const p = this.probs();
      let s = 0;
      for (let i = 0; i < p.length; i++) if ((this.worlds[i] & teamMask) === 0) s += p[i];
      return s;
    }
  }

  // ---------- 似然模型 ----------
  // 每轮任务里坏人整体"藏票"（全出成功）的概率
  const HIDE = [0.4, 0.15, 0.12, 0.1, 0.05];
  const T_VOTE = 0.6;
  const T_PROPOSAL = 0.6;
  const T_SPEECH = 0.4;

  function questLik(e, f, round) {
    if (f > e) return 0;
    if (e === 0) return f === 0 ? 1 : 0;
    const hide = HIDE[round];
    if (f === 0) return hide;
    if (e === 1) return 1 - hide;
    if (f === 1) return (1 - hide) * 0.6;
    return ((1 - hide) * 0.4) / (e - 1);
  }

  function voteLik(voterEvil, dirty, approve, hammer) {
    let p;
    if (hammer) p = voterEvil ? (dirty ? 0.97 : 0.75) : 0.97;
    else if (voterEvil) p = dirty ? 0.85 : 0.3;
    else p = dirty ? 0.45 : 0.65;
    return approve ? p : 1 - p;
  }

  function proposalLik(leaderEvil, evilOnTeam) {
    if (leaderEvil) return evilOnTeam === 0 ? 0.3 : evilOnTeam === 1 ? 1 : 0.6;
    return evilOnTeam === 0 ? 1 : 0.6;
  }

  function applyPublicEvent(belief, ev, n) {
    switch (ev.type) {
      case 'votes': {
        const t = toMask(ev.team);
        belief.update((w) => proposalLik(has(w, ev.leader), popcount(w & t)), T_PROPOSAL);
        const hammer = ev.attempt === 4;
        belief.update((w) => {
          const dirty = (w & t) !== 0;
          let l = 1;
          for (let i = 0; i < n; i++) {
            if (has(t, i)) continue; // 队内成员几乎总会赞成，信息量低
            l *= voteLik(has(w, i), dirty, ev.votes[i], hammer);
          }
          return l;
        }, T_VOTE);
        break;
      }
      case 'quest': {
        const t = toMask(ev.team);
        belief.update((w) => questLik(popcount(w & t), ev.fails, ev.round));
        break;
      }
      case 'speech': {
        if (ev.accuse !== null) {
          belief.update((w) => {
            const sEvil = has(w, ev.speaker);
            const xEvil = has(w, ev.accuse);
            if (sEvil) return xEvil ? 0.3 : 1;
            return xEvil ? 1.4 : 1;
          }, T_SPEECH);
        }
        if (ev.trust !== null) {
          belief.update((w) => {
            const sEvil = has(w, ev.speaker);
            const yEvil = has(w, ev.trust);
            if (sEvil) return yEvil ? 1.1 : 1;
            return yEvil ? 0.6 : 1;
          }, T_SPEECH);
        }
        break;
      }
      case 'ladyClaim': {
        if (ev.claim === null) break;
        const claimEvil = ev.claim === 'evil';
        // 好人如实公布；坏人可能说谎
        belief.update((w) => {
          if (has(w, ev.holder)) return 0.5;
          return has(w, ev.target) === claimEvil ? 0.95 : 0.05;
        });
        break;
      }
      default:
        break;
    }
  }

  // ---------- 难度 ----------
  // noise：决策随机度；cover：梅林放行坏人队伍以自保的概率；blend：坏人模仿好人投票的概率；
  // hide：坏人在各轮任务中藏票的概率；assassinTemp：刺杀时的随机温度
  const LEVELS = {
    easy: { noise: 0.22, cover: 0.3, blend: 0.2, hide: [0.1, 0, 0, 0, 0], assassinTemp: 2 },
    normal: { noise: 0.08, cover: 0.2, blend: 0.5, hide: [0.4, 0.15, 0, 0, 0], assassinTemp: 0.5 },
    hard: { noise: 0.02, cover: 0.15, blend: 0.7, hide: [0.45, 0.2, 0, 0, 0], assassinTemp: 0.25 },
  };

  // ---------- 发言模板 ----------
  const LINES = {
    accuse: [
      '我比较怀疑{X}。',
      '{X}这几轮的投票让我很不放心。',
      '我觉得{X}是坏人的可能性很大。',
      '建议下一轮别带{X}。',
      '{X}的票型和坏人太像了。',
      '如果只能排除一个人，我排除{X}。',
      '{X}一直在替可疑的队伍投赞成。',
      '我盯{X}很久了，越看越不对。',
    ],
    accuseFail: [
      '上一轮的失败票，我觉得出在{X}身上。',
      '失败的任务里有{X}，嫌疑最大。',
      '失败票总得有人出，{X}最说不清楚。',
      '那次任务失败，我第一个怀疑的就是{X}。',
    ],
    agree: [
      '同意{S}的看法，{X}确实可疑。',
      '我和{S}想的一样，{X}有问题。',
      '{S}说得对，{X}要重点提防。',
    ],
    trust: [
      '{X}目前看起来是好人。',
      '我愿意相信{X}。',
      '{X}的表现很正，可以带。',
      '我觉得{X}没问题。',
      '{X}这几票投得很干净。',
      '下一轮我会带上{X}。',
    ],
    none: [
      '信息还不够，我再观察一轮。',
      '暂时没有明确的怀疑对象。',
      '我先听听大家怎么说。',
      '局势还很乱，我保留意见。',
      '我还在对票型，先不点名。',
    ],
  };

  class Bot {
    constructor(view, opts = {}) {
      this.me = view.me;
      this.n = view.n;
      this.numEvil = view.numEvil;
      this.role = view.myRole;
      this.evil = view.myTeam === 'evil';
      this.cfg = LEVELS[opts.level] || LEVELS.normal;
      this.rng = opts.rng || E.makeRng(Math.floor(Math.random() * 4294967296));
      this.names = view.players.map((p) => p.name);
      this.hasMordred = view.roleKeys.includes('mordred');
      this.hasMorgana = view.roleKeys.includes('morgana');

      const meBit = 1 << this.me;
      const seen = view.knowledge.filter((k) => k.tag === 'evil').map((k) => k.id);
      if (this.evil) {
        this.knownEvil = toMask([this.me].concat(seen)); // 奥伯伦只认识自己
      } else {
        this.knownEvil = toMask(seen); // 梅林看到的坏人；其他好人为空
      }

      let filter;
      if (this.evil) {
        const K = this.knownEvil;
        filter = (w) => (w & K) === K;
      } else if (this.role === 'merlin') {
        const S = this.knownEvil;
        filter = (w) => (w & S) === S && !(w & meBit);
      } else if (this.role === 'percival') {
        const cands = view.knowledge.filter((k) => k.tag === 'merlinOrMorgana').map((k) => k.id);
        if (cands.length === 2) {
          const [a, b] = cands;
          filter = (w) => !(w & meBit) && has(w, a) !== has(w, b);
        } else {
          const C = toMask(cands);
          filter = (w) => !(w & meBit) && !(w & C);
        }
      } else {
        filter = (w) => !(w & meBit);
      }
      this.belief = new Belief(this.n, this.numEvil, filter);
      // 公众视角：一个毫无私有信息的旁观者会怎么想。坏人借此判断谁显得可疑。
      this.pub = new Belief(this.n, this.numEvil, () => true);
      // 普通好人视角：梅林和坏人用它来模仿"只靠推理"的好人
      this.naive = this.role === 'merlin' || this.evil ? new Belief(this.n, this.numEvil, (w) => !(w & meBit)) : null;    }

    observe(ev) {
      if (ev.type === 'ladyResult') {
        if (ev.holder !== this.me) return;
        const fn = (w) => (has(w, ev.target) === ev.isEvil ? 1 : 0);
        this.belief.update(fn);
        if (this.naive) this.naive.update(fn);
        return;
      }
      applyPublicEvent(this.belief, ev, this.n);
      applyPublicEvent(this.pub, ev, this.n);
      if (this.naive) applyPublicEvent(this.naive, ev, this.n);
    }

    decide(view) {
      switch (view.phase) {
        case 'propose': return { type: 'propose', team: this.propose(view) };
        case 'vote': return { type: 'vote', approve: this.vote(view) };
        case 'quest': return { type: 'quest', success: this.quest(view) };
        case 'lady': return { type: 'lady', target: this.ladyTarget(view) };
        case 'ladyClaim': return { type: 'ladyClaim', claim: this.ladyClaim(view) };
        case 'discuss': return Object.assign({ type: 'speak' }, this.speak(view));
        case 'assassinate': return { type: 'assassinate', target: this.assassinate(view) };
        default: throw new Error(`AI 无法处理阶段 ${view.phase}`);
      }
    }

    chance(p) {
      return this.rng() < p;
    }

    critical(view) {
      return view.fails === 2 || view.successes === 2;
    }

    // 好人眼中某队伍"干净"的程度。梅林会把真实信息与普通好人的推理混合，避免太过精准而暴露。
    cleanScore(mask, critical) {
      if (this.role !== 'merlin') return this.belief.pClean(mask);
      const alpha = critical ? 1 : 0.6;
      return alpha * this.belief.pClean(mask) + (1 - alpha) * this.naive.pClean(mask);
    }

    // 从候选中选分数最高者，带少量随机性
    pickTop(cands, scoreFn) {
      const scored = cands.map((c) => ({ c, s: scoreFn(c) })).sort((a, b) => b.s - a.s);
      if (this.chance(this.cfg.noise)) {
        const top = scored.slice(0, Math.max(2, Math.ceil(scored.length / 4)));
        return this.rng.pick(top).c;
      }
      const best = scored[0].s;
      const near = scored.filter((x) => x.s >= best - 0.02 - Math.abs(best) * 0.03);
      return this.rng.pick(near).c;
    }

    // ---------- 组队 ----------
    propose(view) {
      return this.evil ? this.proposeEvil(view) : this.proposeGood(view);
    }

    proposeGood(view) {
      const critical = this.critical(view);
      const meBit = 1 << this.me;
      const cands = allTeams(this.n, view.teamSize).filter((t) => t & meBit);
      return fromMask(this.pickTop(cands, (t) => this.cleanScore(t, critical)), this.n);
    }

    proposeEvil(view) {
      const size = view.teamSize;
      const need = view.requiredFails;
      const team = [this.me];
      const mates = fromMask(this.knownEvil, this.n).filter((id) => id !== this.me);
      if (need === 2 && mates.length) {
        mates.sort((a, b) => this.pub.pEvil(a) - this.pub.pEvil(b));
        team.push(mates[0]);
      }
      const others = [];
      for (let i = 0; i < this.n; i++) {
        if (!has(this.knownEvil, i)) others.push({ id: i, s: this.pub.pEvil(i) + this.rng() * 0.15 });
      }
      others.sort((a, b) => a.s - b.s);
      for (const o of others) {
        if (team.length >= size) break;
        team.push(o.id);
      }
      // 理论上不会发生（好人数量足够），保险起见用剩余玩家补齐
      for (let i = 0; team.length < size && i < this.n; i++) if (!team.includes(i)) team.push(i);
      return team.sort((a, b) => a - b);
    }

    // ---------- 投票 ----------
    vote(view) {
      return this.evil ? this.voteEvil(view) : this.voteGood(view);
    }

    // 与同人数下最干净的队伍相比，这支队伍够不够好
    reasonableVote(view, t, scoreFn) {
      if (view.leader === this.me) return true;
      const pc = scoreFn(t);
      let best = 0;
      for (const cand of allTeams(this.n, view.teamSize)) {
        const s = scoreFn(cand);
        if (s > best) best = s;
      }
      const threshold = view.attempt === 3 ? 0.5 : 0.72;
      let approve = pc >= best * threshold - 1e-9;
      if (this.chance(this.cfg.noise)) approve = !approve;
      return approve;
    }

    voteGood(view) {
      if (view.attempt === 4) return true; // 第五次否决直接判坏人胜
      const critical = this.critical(view);
      const t = toMask(view.team);
      if (this.role === 'merlin' && (t & this.knownEvil) && view.leader !== this.me) {
        return !critical && this.chance(this.cfg.cover);
      }
      return this.reasonableVote(view, t, (m) => this.cleanScore(m, critical));
    }

    voteEvil(view) {
      const t = toMask(view.team);
      const evilOn = popcount(t & this.knownEvil);
      const need = view.requiredFails;
      if (view.attempt === 4) return evilOn > 0 || this.chance(0.85);
      if (evilOn >= need) return this.chance(0.92);
      if (this.critical(view)) return evilOn > 0 ? this.chance(0.6) : this.chance(0.05);
      if (evilOn > 0) return this.chance(0.6);
      // 干净的队伍：多数时候装成普通好人来投票，否则反对
      return this.chance(this.cfg.blend) && this.reasonableVote(view, t, (m) => this.naive.pClean(m));
    }

    // ---------- 任务 ----------
    quest(view) {
      if (!this.evil) return true;
      if (view.requiredFails === 2) return false;
      if (this.critical(view)) return false;
      // 多名互相认识的坏人同队时，约定由座位号最小的人出失败票
      const mates = view.team.filter((id) => has(this.knownEvil, id));
      if (mates.length > 1 && this.me !== Math.min(...mates)) return true;
      if (this.chance(this.cfg.hide[view.round])) return true;
      return false;
    }

    // ---------- 湖中仙女 ----------
    ladyEligible(view) {
      const out = [];
      for (let i = 0; i < this.n; i++) if (i !== this.me && !view.lady.used.includes(i)) out.push(i);
      return out;
    }

    ladyTarget(view) {
      const elig = this.ladyEligible(view);
      if (!this.evil) {
        // 查验最不确定的人
        const ent = (i) => { const p = this.belief.pEvil(i); return p * (1 - p); };
        const best = Math.max(...elig.map(ent));
        if (best > 0.01) return this.pickTop(elig, ent);
        // 梅林没有不确定性时：查一个看起来可信的坏人，借机揭穿
        const evilElig = elig.filter((i) => has(this.knownEvil, i));
        if (evilElig.length) return this.pickTop(evilElig, (i) => -this.naive.pEvil(i));
        return this.rng.pick(elig);
      }
      const mates = elig.filter((i) => has(this.knownEvil, i));
      const exposed = mates.filter((i) => this.pub.pEvil(i) > 0.5);
      if (exposed.length && this.chance(0.4)) return this.rng.pick(exposed);
      const goods = elig.filter((i) => !has(this.knownEvil, i));
      if (!goods.length) return this.rng.pick(elig);
      return this.pickTop(goods, (i) => -this.pub.pEvil(i));
    }

    ladyClaim(view) {
      const r = view.ladyPending || view.ladyResults[view.ladyResults.length - 1];
      if (!this.evil) return r.isEvil ? 'evil' : 'good';
      if (r.isEvil) return 'good'; // 替队友洗白
      return this.chance(0.35) ? 'evil' : 'good'; // 偶尔栽赃好人
    }

    // ---------- 发言 ----------
    speak(view) {
      const prior = this.numEvil / (this.n - 1);
      const others = [];
      for (let i = 0; i < this.n; i++) if (i !== this.me) others.push(i);
      let accuse = null;
      let trust = null;

      if (!this.evil && this.role !== 'merlin') {
        const ranked = others.map((i) => ({ i, p: this.belief.pEvil(i) })).sort((a, b) => b.p - a.p);
        if (ranked[0].p > Math.max(prior * 1.2, 0.3)) accuse = ranked[0].i;
        const low = ranked[ranked.length - 1];
        if (low.p < prior * 0.6 && low.i !== accuse) trust = low.i;
      } else if (this.role === 'merlin') {
        // 梅林只说"普通好人也能推出来"的话，并偏向点出真正的坏人
        const visible = fromMask(this.knownEvil, this.n)
          .map((i) => ({ i, p: this.naive.pEvil(i) }))
          .sort((a, b) => b.p - a.p);
        if (visible.length && (visible[0].p >= prior * 0.9 || this.chance(0.25))) accuse = visible[0].i;
        const goods = others
          .filter((i) => !has(this.knownEvil, i) && this.belief.pEvil(i) < 0.05)
          .map((i) => ({ i, p: this.naive.pEvil(i) }))
          .sort((a, b) => a.p - b.p);
        if (goods.length && goods[0].p < prior && this.chance(0.7)) trust = goods[0].i;
      } else {
        const goods = others.filter((i) => !has(this.knownEvil, i)).map((i) => ({ i, p: this.pub.pEvil(i) }));
        goods.sort((a, b) => b.p - a.p);
        const mates = others.filter((i) => has(this.knownEvil, i)).map((i) => ({ i, p: this.pub.pEvil(i) }));
        const burnt = mates.filter((m) => m.p > 0.8);
        if (burnt.length && this.chance(0.25)) {
          accuse = burnt[0].i; // 弃车保帅
        } else if (goods.length && (goods[0].p > prior * 0.8 || this.chance(0.4))) {
          accuse = goods[0].p > prior * 0.8 ? goods[0].i : this.rng.pick(goods).i;
        }
        if (this.chance(0.35)) {
          const safe = goods.filter((g) => g.i !== accuse).sort((a, b) => a.p - b.p);
          if (safe.length) trust = safe[0].i;
        }
      }
      return { accuse, trust, text: this.phrase(view, accuse, trust) };
    }

    phrase(view, accuse, trust) {
      const said = view.speeches.filter((sp) => sp.round === view.round);
      const usedText = said.map((sp) => sp.text).join('|');
      // 优先选用本轮还没人说过的句式
      const pick = (pool, vars) => {
        const lines = this.rng.shuffle(pool.slice()).map((tpl) => tpl
          .replace('{X}', vars.X !== undefined ? this.names[vars.X] : '')
          .replace('{S}', vars.S !== undefined ? this.names[vars.S] : ''));
        return lines.find((line) => !usedText.includes(line)) || lines[0];
      };
      const parts = [];
      if (accuse !== null) {
        const echo = said.find((sp) => sp.accuse === accuse && sp.speaker !== this.me);
        const last = view.quests[view.quests.length - 1];
        if (echo && this.chance(0.5)) parts.push(pick(LINES.agree, { X: accuse, S: echo.speaker }));
        else if (last && !last.success && last.team.includes(accuse)) parts.push(pick(LINES.accuseFail, { X: accuse }));
        else parts.push(pick(LINES.accuse, { X: accuse }));
      }
      if (trust !== null) parts.push(pick(LINES.trust, { X: trust }));
      if (!parts.length) parts.push(pick(LINES.none, {}));
      return parts.join('');
    }

    // ---------- 刺杀 ----------
    assassinate(view) {
      const evilIds = view.evilReveal.map((x) => x.id);
      const visible = toMask(view.evilReveal.filter((x) => x.role !== 'mordred').map((x) => x.id));
      const cands = [];
      for (let i = 0; i < this.n; i++) if (!evilIds.includes(i)) cands.push(i);
      const scores = cands.map((c) => merlinScore(c, view, visible));
      const temp = this.cfg.assassinTemp;
      const max = Math.max(...scores);
      const ws = scores.map((s) => Math.exp((s - max) / temp));
      const sum = ws.reduce((a, b) => a + b, 0);
      let r = this.rng() * sum;
      for (let k = 0; k < cands.length; k++) {
        r -= ws[k];
        if (r <= 0) return cands[k];
      }
      return cands[cands.length - 1];
    }
  }

  // 对数似然比：候选人的行为有多像"知道坏人是谁"的梅林
  function merlinScore(c, view, visible) {
    let s = 0;
    for (const p of view.proposals) {
      const t = toMask(p.team);
      const dirty = (t & visible) !== 0;
      if (p.leader === c) s += Math.log(dirty ? 0.25 / 0.55 : 0.75 / 0.45);
      if (has(t, c) || p.attempt === 4) continue;
      const a = p.votes[c];
      if (dirty) s += Math.log(a ? 0.25 / 0.5 : 0.75 / 0.5);
      else s += Math.log(a ? 0.7 / 0.6 : 0.3 / 0.4);
    }
    for (const sp of view.speeches) {
      if (sp.speaker !== c) continue;
      if (sp.accuse !== null) s += has(visible, sp.accuse) ? Math.log(0.6 / 0.35) : Math.log(0.4 / 0.65);
      if (sp.trust !== null && has(visible, sp.trust)) s += Math.log(0.1 / 0.3);
    }
    return s;
  }

  // ---------- 对局驱动 ----------
  function createBots(game, opts = {}) {
    return game.players.map((p) => {
      if (p.human) return null;
      const rng = E.makeRng((game.seed ^ Math.imul(p.id + 1, 0x9e3779b1)) >>> 0);
      return new Bot(game.viewFor(p.id), { level: opts.level, rng });
    });
  }

  function feed(bots, events) {
    for (const ev of events) {
      for (const bot of bots) {
        if (bot && (ev.to === null || ev.to.includes(bot.me))) bot.observe(ev);
      }
    }
  }

  // 让一个待行动的 AI 行动；若当前只等人类或游戏结束则返回 null
  function stepAI(game, bots) {
    const actor = game.pendingActors().find((id) => bots[id]);
    if (actor === undefined) return null;
    const action = bots[actor].decide(game.viewFor(actor));
    const events = game.act(actor, action);
    feed(bots, events);
    return { actor, action, events };
  }

  function playOut(game, bots) {
    while (game.phase !== 'over') {
      if (!stepAI(game, bots)) throw new Error('对局卡住：等待非 AI 玩家');
    }
    return game;
  }

  const api = {
    Bot, Belief, LEVELS, createBots, feed, stepAI, playOut, merlinScore,
    _internal: { combos, popcount, toMask, fromMask, questLik },
  };
  if (isNode) module.exports = api;
  else (root.Avalon = root.Avalon || {}).AI = api;
})(typeof window !== 'undefined' ? window : globalThis);
