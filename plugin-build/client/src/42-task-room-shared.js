    const taskPhases = {
      selecting: 'Leader 选择编排',
      material: '读取 PR 快照',
      reviewing: 'DSH 和 Codex 独立审查',
      'cross-check': '互相复核',
      summarizing: 'Leader 汇总报告',
      handoff: '交接给 Leader',
      assignment: '群角色与执行配置',
      designing: 'Leader 设计和拆分',
      coding: 'Coder 编码',
      'dev-reviewing': 'Reviewer 审查',
      'coding-assistant': '编码 Codex 子 Agent',
      'review-assistant': '审查 Codex 子 Agent',
      'development-patch': '固定开发补丁',
      'private-memory': '私有记忆回执',
      conversation: '群内讨论',
      steering: '运行中插话',
      revision: '补充修正',
      review: '待确认',
      confirmed: '验收确认',
      dispatch: '自动派单',
    };

    const AGENT_BUBBLE_PALETTE = [
      '#8b5cf6', // 靛紫
      '#10b981', // 翠绿
      '#f59e0b', // 琥珀
      '#0ea5e9', // 晴蓝
      '#ec4899', // 玫红
      '#06b6d4', // 青色
      '#f97316', // 珊瑚橙
      '#84cc16', // 青柠
    ];

    const NAMED_AGENT_COLORS = {
      '丞相': '#8b5cf6',
      '工部尚书': '#10b981',
      '刑部尚书': '#f59e0b',
      '侍中': '#ec4899',
      '中书令': '#0ea5e9',
      '吏部尚书': '#f97316',
      '兵部尚书': '#ef4444',
      '户部尚书': '#eab308',
      '礼部尚书': '#a855f7',
    };

    function agentBubbleAccent(actorName, colorMap) {
      const clean = String(actorName || '').trim();
      if (!clean) return AGENT_BUBBLE_PALETTE[0];
      if (colorMap && colorMap.has(clean)) return colorMap.get(clean);
      if (clean.startsWith('Codex')) return '#06b6d4';
      if (NAMED_AGENT_COLORS[clean]) return NAMED_AGENT_COLORS[clean];
      let hash = 2166136261;
      for (let i = 0; i < clean.length; i++) {
        hash ^= clean.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return AGENT_BUBBLE_PALETTE[(hash >>> 0) % AGENT_BUBBLE_PALETTE.length];
    }

    function buildRoomColorMap(records, participants) {
      const map = new Map();
      const used = new Set();
      const assign = name => {
        const clean = String(name || '').trim();
        if (!clean || clean === 'Marshal' || clean === '工单操作者' || map.has(clean)) return;
        const preferred = clean.startsWith('Codex') ? '#06b6d4' : NAMED_AGENT_COLORS[clean];
        if (preferred && !used.has(preferred)) {
          map.set(clean, preferred);
          used.add(preferred);
          return;
        }
        const free = AGENT_BUBBLE_PALETTE.find(c => !used.has(c));
        if (free) {
          map.set(clean, free);
          used.add(free);
          return;
        }
        map.set(clean, agentBubbleAccent(clean));
      };
      for (const p of Array.isArray(participants) ? participants : []) assign(p?.name);
      for (const r of Array.isArray(records) ? records : []) {
        if (r?.kind === 'agent') assign(r.actor);
      }
      return map;
    }

    function ensureTaskRoomStyles() {
      if (typeof document === 'undefined') return;
      const existing = document.getElementById('marshal-taskroom-styles');
      const style = existing || document.createElement('style');
      style.id = 'marshal-taskroom-styles';
      style.textContent = [
        '.mtr-shell{display:flex;flex:1;min-height:0;width:100%;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit)}',
        '.mtr-side{width:min(29%,276px);flex-shrink:0;padding:14px 12px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.03));display:flex;flex-direction:column;gap:8px}',
        '.mtr-room-item{display:flex;flex-direction:column;gap:4px;width:100%;padding:9px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14));background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;transition:background .14s,border-color .14s}',
        '.mtr-room-item:hover{background:color-mix(in srgb,currentColor 6%,transparent)}',
        '.mtr-room-item[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6366f1) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#6366f1) 48%,transparent)}',
        '.mtr-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}',
        '.mtr-header{padding:11px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));display:flex;gap:10px;flex-wrap:wrap;align-items:center;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.02))}',
        '.mtr-review-bar{margin:10px 18px 0;padding:11px 14px;border-radius:12px;border:1px solid color-mix(in srgb,#8b5cf6 42%,transparent);background:color-mix(in srgb,#8b5cf6 10%,var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06)));display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}',
        '.mtr-att-bar{margin:8px 18px 0;padding:8px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04));display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
        '.mtr-stream{flex:1;min-height:0;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px}',
        '.mtr-sys-row{display:flex;justify-content:center;margin:2px 0}',
        '.mtr-sys-pill{max-width:86%;padding:4px 12px;border-radius:999px;font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,rgba(140,145,158,.92));background:color-mix(in srgb,currentColor 7%,transparent);border:1px solid color-mix(in srgb,currentColor 10%,transparent);text-align:center;overflow-wrap:anywhere}',
        '.mtr-sys-pill[data-tone="danger"]{color:#ef4444;background:color-mix(in srgb,#ef4444 10%,transparent);border-color:color-mix(in srgb,#ef4444 28%,transparent)}',
        '.mtr-sys-pill[data-tone="review"]{color:#a78bfa;background:color-mix(in srgb,#8b5cf6 12%,transparent);border-color:color-mix(in srgb,#8b5cf6 32%,transparent)}',
        '.mtr-brief-card{align-self:stretch;padding:10px 14px;border-radius:12px;border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:color-mix(in srgb,currentColor 4%,transparent);font-size:12.5px}',
        '.mtr-msg-row{display:flex;gap:10px;align-items:flex-start;max-width:100%}',
        '.mtr-msg-row[data-side="right"]{flex-direction:row-reverse}',
        '.mtr-avatar{width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;margin-top:2px;box-shadow:0 2px 6px rgba(0,0,0,.12)}',
        '.mtr-msg-col{display:flex;flex-direction:column;max-width:min(80%,760px);min-width:0}',
        '.mtr-msg-row[data-side="right"] .mtr-msg-col{align-items:flex-end;max-width:min(76%,660px)}',
        '.mtr-msg-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;margin-bottom:4px;color:var(--dsw-alias-label-secondary,rgba(140,145,158,.9))}',
        '.mtr-msg-row[data-side="right"] .mtr-msg-meta{flex-direction:row-reverse}',
        '.mtr-role-badge{font-size:10.5px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--mtr-agent-c,#6366f1) 15%,transparent);color:var(--mtr-agent-c,#6366f1);border:1px solid color-mix(in srgb,var(--mtr-agent-c,#6366f1) 30%,transparent)}',
        '.mtr-bubble{padding:10px 14px;font-size:13px;line-height:1.65;overflow-wrap:anywhere;word-break:break-word;box-shadow:0 2px 8px -3px rgba(0,0,0,.14)}',
        '.mtr-bubble-agent{border-radius:4px 16px 16px 16px;background:color-mix(in srgb,var(--mtr-agent-c,#6366f1) 9%,var(--dsw-alias-bg-layer-2,rgba(128,128,140,.08)));border:1px solid color-mix(in srgb,var(--mtr-agent-c,#6366f1) 26%,var(--dsw-alias-border-l1,rgba(128,128,128,.16)));border-left:3px solid var(--mtr-agent-c,#6366f1)}',
        '.mtr-bubble-user{border-radius:16px 4px 16px 16px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 22%,var(--dsw-alias-bg-layer-3,rgba(79,70,229,.14)));border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6366f1) 44%,transparent)}',
        '.mtr-patch-card{align-self:flex-start;width:min(84%,760px);padding:11px 14px;border-radius:12px;border:1px solid color-mix(in srgb,#06b6d4 34%,var(--dsw-alias-border-l2,rgba(128,128,128,.2)));background:color-mix(in srgb,#06b6d4 7%,var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06)))}',
        '.mtr-md{font-size:13px;line-height:1.68;overflow-wrap:anywhere}',
        '.mtr-md > *:first-child{margin-top:0!important}',
        '.mtr-md > *:last-child{margin-bottom:0!important}',
        '.mtr-md p{margin:0 0 8px;white-space:pre-wrap}',
        '.mtr-md h1,.mtr-md h2,.mtr-md h3,.mtr-md h4,.mtr-md h5,.mtr-md h6{margin:12px 0 6px;line-height:1.35;font-weight:650}',
        '.mtr-md h1{font-size:16px}.mtr-md h2{font-size:15px}.mtr-md h3{font-size:14px}.mtr-md h4,.mtr-md h5,.mtr-md h6{font-size:13px}',
        '.mtr-md ul,.mtr-md ol{margin:6px 0 10px;padding-left:20px}',
        '.mtr-md li{margin:3px 0}',
        '.mtr-md blockquote{margin:8px 0;padding:5px 12px;border-left:3px solid var(--mtr-agent-c,var(--dsw-alias-brand-primary,#6366f1));background:color-mix(in srgb,currentColor 5%,transparent);border-radius:0 8px 8px 0;opacity:.92}',
        '.mtr-md hr{border:0;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent);margin:10px 0}',
        '.mtr-md a{color:var(--dsw-alias-brand-primary,#6366f1);text-decoration:underline;text-underline-offset:2px}',
        '.mtr-inline-code{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;padding:1.5px 5px;border-radius:5px;background:color-mix(in srgb,currentColor 10%,transparent);border:1px solid color-mix(in srgb,currentColor 12%,transparent)}',
        '.mtr-mention{display:inline-block;padding:0 5px;border-radius:5px;font-weight:600;color:var(--dsw-alias-brand-primary,#6366f1);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6366f1) 14%,transparent)}',
        '.mtr-code-box{margin:8px 0;border-radius:9px;overflow:hidden;border:1px solid color-mix(in srgb,currentColor 16%,transparent);background:color-mix(in srgb,#000 22%,var(--dsw-alias-bg-base,rgba(0,0,0,.18)))}',
        '.mtr-code-bar{display:flex;align-items:center;justify-content:space-between;padding:4px 10px;font-size:11px;color:var(--dsw-alias-label-secondary,rgba(150,155,168,.95));border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);background:color-mix(in srgb,currentColor 5%,transparent)}',
        '.mtr-code-copy{border:0;background:transparent;color:inherit;font:11px/1.2 inherit;padding:2px 6px;border-radius:5px;cursor:pointer}',
        '.mtr-code-copy:hover{background:color-mix(in srgb,currentColor 10%,transparent)}',
        '.mtr-code-pre{margin:0;padding:10px 12px;overflow-x:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;white-space:pre;tab-size:2}',
        '.mtr-table-wrap{margin:8px 0;overflow-x:auto;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 15%,transparent)}',
        '.mtr-table{width:100%;border-collapse:collapse;font-size:12px}',
        '.mtr-table th,.mtr-table td{padding:6px 10px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);text-align:left}',
        '.mtr-table th{font-weight:600;background:color-mix(in srgb,currentColor 6%,transparent)}',
        '.mtr-raw-json{margin-top:8px;font-size:11.5px}',
        '.mtr-raw-json > summary{cursor:pointer;user-select:none;opacity:.72;font-size:11px}',
        '.mtr-composer{padding:10px 16px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.03));display:grid;gap:8px}',
        '.mtr-chip-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
        '.mtr-mention-chip{border:1px solid color-mix(in srgb,var(--mtr-chip-c,currentColor) 32%,transparent);background:color-mix(in srgb,var(--mtr-chip-c,currentColor) 10%,transparent);color:inherit;border-radius:999px;padding:2px 9px;font-size:11px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:4px}',
        '.mtr-mention-chip:hover{background:color-mix(in srgb,var(--mtr-chip-c,currentColor) 18%,transparent)}',
        '@keyframes mtrPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.38;transform:scale(.85)}}',
        '.mtr-live-badge{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;padding:1.5px 8px;border-radius:999px;color:#3b82f6;background:color-mix(in srgb,#3b82f6 13%,transparent);border:1px solid color-mix(in srgb,#3b82f6 34%,transparent)}',
        '.mtr-live-dot{width:6px;height:6px;border-radius:50%;background:#3b82f6;animation:mtrPulse 1.35s ease-in-out infinite}',
        '.mtr-bubble-live{box-shadow:0 0 0 1px color-mix(in srgb,var(--mtr-agent-c,#6366f1) 28%,transparent),0 6px 18px rgba(0,0,0,.08)}',
        '.mtr-trace{margin:0 0 8px;border-radius:10px;border:1px solid color-mix(in srgb,var(--mtr-agent-c,#6366f1) 24%,var(--dsw-alias-border-l1,rgba(128,128,128,.18)));background:color-mix(in srgb,var(--mtr-agent-c,#6366f1) 6%,var(--dsw-alias-bg-base,rgba(0,0,0,.14)));overflow:hidden}',
        '.mtr-trace:last-child{margin-bottom:0}',
        '.mtr-trace-sum{cursor:pointer;user-select:none;padding:6px 10px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,rgba(148,154,168,.95));display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
        '.mtr-trace-sum:hover{background:color-mix(in srgb,currentColor 5%,transparent)}',
        '.mtr-trace-body{padding:8px 10px 10px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);display:grid;gap:8px;font-size:12px}',
        '.mtr-trace-steps{display:grid;gap:4px}',
        '.mtr-trace-step{display:flex;align-items:flex-start;gap:6px;font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;padding:3px 7px;border-radius:6px;background:color-mix(in srgb,currentColor 5%,transparent);overflow-wrap:anywhere}',
        '.mtr-trace-step[data-st="running"]{color:#60a5fa;background:color-mix(in srgb,#3b82f6 11%,transparent)}',
        '.mtr-trace-step[data-st="failed"]{color:#f87171;background:color-mix(in srgb,#ef4444 11%,transparent)}',
        '.mtr-trace-think{margin:0;padding:8px 10px;max-height:220px;overflow-y:auto;border-radius:7px;font:11.5px/1.55 inherit;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,rgba(155,160,175,.95));background:color-mix(in srgb,#000 14%,transparent);border-left:2.5px solid color-mix(in srgb,var(--mtr-agent-c,#6366f1) 55%,transparent)}',
        '.mtr-tok-badge{display:inline-flex;align-items:center;gap:4px;font:10.5px/1.35 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;padding:1.5px 7px;border-radius:999px;color:var(--dsw-alias-label-secondary,rgba(150,156,170,.95));background:color-mix(in srgb,currentColor 8%,transparent);border:1px solid color-mix(in srgb,currentColor 14%,transparent);white-space:nowrap}',
        '.mtr-trace-usage{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:4px 8px;border-radius:6px;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--dsw-alias-label-secondary,rgba(150,156,170,.95));background:color-mix(in srgb,currentColor 6%,transparent)}',
      ].join('\n');
      if (!existing) document.head.appendChild(style);
    }

