#!/usr/bin/env node
/* 让 AI 互相对战，统计胜率。用法：node scripts/simulate.js [局数] [难度] */
'use strict';
const { createGame } = require('../js/engine.js');
const AI = require('../js/ai.js');

const games = Number(process.argv[2]) || 500;
const level = process.argv[3] || 'normal';

console.log(`每种人数 ${games} 局，难度 ${level}`);
for (let n = 5; n <= 10; n++) {
  const stats = { good: 0, evil: 0, reasons: {}, assassinTries: 0, assassinHits: 0, rounds: 0 };
  for (let g = 0; g < games; g++) {
    const game = createGame({ numPlayers: n, seed: n * 100000 + g });
    AI.playOut(game, AI.createBots(game, { level }));
    stats[game.winner]++;
    stats.reasons[game.endReason] = (stats.reasons[game.endReason] || 0) + 1;
    stats.rounds += game.quests.length;
    if (game.assassination) {
      stats.assassinTries++;
      if (game.assassination.success) stats.assassinHits++;
    }
  }
  const pct = (x) => `${((x / games) * 100).toFixed(1)}%`;
  console.log(
    `${n}人：好人 ${pct(stats.good)}  坏人 ${pct(stats.evil)}  平均任务数 ${(stats.rounds / games).toFixed(2)}  ` +
    `刺杀命中 ${stats.assassinHits}/${stats.assassinTries}`,
  );
  console.log('     ', Object.entries(stats.reasons).map(([k, v]) => `${k}: ${v}`).join('；'));
}
