'use strict';

/**
 * Süreç yükü — scalp-bot infoBot.js'teki ölçümün aynısı.
 * Event loop gecikmesi, CPU kullanımı ve (Fly gibi paylaşımlı makinelerde CPU kotası dolunca görülen)
 * steal oranı. WS gecikmesi yüksekse ya da 1006 kopuşları varsa sebep buradan okunur: event loop
 * tıkanırsa Binance'in ping'ine pong zamanında dönmez, bağlantı 1006 ile düşer.
 */

const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');

function readSteal() {
  try {
    const f = fs.readFileSync('/proc/stat', 'utf8').split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
    return { total: f.reduce((a, b) => a + b, 0), steal: f[7] || 0 };
  } catch { return null; }
}

function createLoadMonitor() {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let last = { at: Date.now(), cpu: process.cpuUsage(), stat: readSteal() };

  return {
    /** Son çağrıdan bu yana: { cpuPct, stealPct|null, loopP99Ms, loopMaxMs } — döndürür ve sıfırlar */
    take() {
      const now = Date.now(), cpu = process.cpuUsage(), stat = readSteal();
      const wallUs = Math.max(1, (now - last.at) * 1000);
      const cpuPct = (cpu.user - last.cpu.user + cpu.system - last.cpu.system) / wallUs * 100;
      const dt = stat && last.stat ? stat.total - last.stat.total : 0;
      const stealPct = dt > 0 ? (stat.steal - last.stat.steal) / dt * 100 : null;
      const out = { cpuPct, stealPct, loopP99Ms: loop.percentile(99) / 1e6, loopMaxMs: loop.max / 1e6 };
      loop.reset();
      last = { at: now, cpu, stat };
      return out;
    },
    stop() { loop.disable(); },
  };
}

function loadText(l) {
  return `CPU %${l.cpuPct.toFixed(0)}${l.stealPct != null ? ` (steal %${l.stealPct.toFixed(0)})` : ''} · event loop p99 ${Math.round(l.loopP99Ms)} ms, en fazla ${(l.loopMaxMs / 1000).toFixed(1)} sn`;
}

module.exports = { createLoadMonitor, loadText };
