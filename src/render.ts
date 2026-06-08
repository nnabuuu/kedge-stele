import type { WaitingItem } from "./projections.ts";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function item(w: WaitingItem): string {
  const cls = w.bucket === "open" ? "open" : "deferred";
  const flag = w.needsCheck ? `<span class="flag">复审条件可能已满足 · CHECK</span>` : "";
  const trig = w.trigger ? `<div class="trig"><span class="lbl">复审触发</span>${esc(w.trigger)}</div>` : "";
  return `
    <div class="card ${cls} ${w.needsCheck ? "due" : ""}">
      <div class="top">
        <span class="id">${esc(w.id)}</span>
        <span class="bucket ${cls}">${w.bucket === "open" ? "OPEN" : "DEFERRED"}</span>
        <span class="age">${w.ageDays}d</span>
        ${flag}
      </div>
      <div class="title">${esc(w.title)}</div>
      <div class="detail">${esc(w.detail)}</div>
      ${trig}
    </div>`;
}

export function renderResume(items: WaitingItem[], generatedAt = new Date()): string {
  const due = items.filter((i) => i.needsCheck);
  const open = items.filter((i) => i.bucket === "open" && !i.needsCheck);
  const deferred = items.filter((i) => i.bucket === "deferred" && !i.needsCheck);

  const section = (title: string, en: string, list: WaitingItem[]) =>
    list.length
      ? `<div class="sec-h"><h2>${title} <span class="en">${en}</span></h2><span class="hint">${list.length} 项</span></div>
         <div class="grid">${list.map(item).join("")}</div>`
      : "";

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>什么在等我 · Resume Digest</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Fraunces:opsz,wght@9..144,400;9..144,500&family=JetBrains+Mono:wght@400;600&display=swap');
:root{--bg:#f4f3ef;--surface:#fbfaf7;--surface2:#edece7;--t1:#1c1c1a;--t2:#5c5b56;--t3:#9c9a92;
--border:rgba(28,28,26,.07);--teal:#0d5245;--teal-bg:#dfece8;--purple:#3a3185;--purple-bg:#e9e7f3;
--amber:#7a4d0e;--amber-bg:#f6edda;--red:#942929;--red-bg:#f6dada;--green:#2d6612;--green-bg:#e6f2dc;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Plus Jakarta Sans",-apple-system,"PingFang SC",sans-serif;background:var(--bg);color:var(--t1);-webkit-font-smoothing:antialiased}
.wrap{max-width:920px;margin:0 auto;padding:48px 40px 80px}
header{margin-bottom:36px}
.eyebrow{font-size:11px;font-weight:600;color:var(--t2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px}
h1{font-family:"Fraunces",Georgia,serif;font-size:34px;font-weight:500;letter-spacing:-1px}
.sub{font-size:13px;color:var(--t3);margin-top:6px}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;margin:34px 0 16px}
.sec-h h2{font-size:19px;font-weight:700;letter-spacing:-.3px}
.sec-h .en{font-size:12px;color:var(--t3);font-weight:500;margin-left:4px}
.sec-h .hint{font-size:12px;color:var(--t3)}
.grid{display:flex;flex-direction:column;gap:11px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:16px 20px}
.card.open{border-left:3px solid var(--purple)}
.card.deferred{border-left:3px solid var(--amber)}
.card.due{border-left:3px solid var(--red);background:#fcf7f5}
.top{display:flex;align-items:center;gap:10px;margin-bottom:7px}
.id{font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:600;color:var(--t2)}
.bucket{font-size:9px;font-weight:700;letter-spacing:.4px;padding:2px 7px;border-radius:3px}
.bucket.open{background:var(--purple-bg);color:var(--purple)}
.bucket.deferred{background:var(--amber-bg);color:var(--amber)}
.age{font-size:11px;color:var(--t3);font-weight:600}
.flag{margin-left:auto;font-size:9px;font-weight:700;letter-spacing:.3px;color:var(--red);background:var(--red-bg);padding:2px 8px;border-radius:3px}
.title{font-size:15px;font-weight:600;letter-spacing:-.2px;margin-bottom:5px}
.detail{font-size:13px;color:var(--t2);line-height:1.6}
.trig{font-size:12px;color:var(--t3);margin-top:8px;padding-top:8px;border-top:1px dashed var(--border)}
.trig .lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-right:6px;color:var(--amber)}
.empty{font-size:14px;color:var(--t3);padding:40px;text-align:center}
footer{margin-top:48px;font-size:11px;color:var(--t3)}
</style></head>
<body><div class="wrap">
<header>
  <div class="eyebrow">Resume Digest · 跨 session 的开放回路</div>
  <h1>什么在等我</h1>
  <div class="sub">${items.length} 个未闭合的决策回路 · 生成于 ${generatedAt.toISOString().slice(0, 16).replace("T", " ")}</div>
</header>
${items.length === 0 ? `<div class="empty">没有未闭合的回路 — 全部 decided / resolved。</div>` : ""}
${section("可能到期了", "复审条件或已满足", due)}
${section("开放问题", "真正还没答案的", open)}
${section("已推迟", "等触发条件", deferred)}
<footer>stele · resume digest 是 decision DAG 的一个投影 · 每次从 store 重新生成,永不 stale</footer>
</div></body></html>`;
}
