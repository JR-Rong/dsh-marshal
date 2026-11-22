    function ensureTaskBoardStyles() {
      if (typeof document === 'undefined') return;
      const existing = document.getElementById('marshal-taskboard-styles');
      const style = existing || document.createElement('style');
      style.id = 'marshal-taskboard-styles';
      style.textContent = [
        '@keyframes mtb-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--mtb-accent) 55%,transparent)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}',
        '@keyframes mtb-spin{to{transform:rotate(360deg)}}',
        '.mtb-page{flex:1;min-height:0;min-width:0;width:100%;overflow:hidden;display:flex;flex-direction:column;position:relative;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit)}',
        '.mtb-head{padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent));display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;flex-shrink:0}',
        '.mtb-head-left{display:flex;align-items:center;gap:14px;flex-wrap:wrap;min-width:0}',
        '.mtb-head-right{display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap}',
        '.mtb-summary{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.mtb-summary-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--mtb-accent) 28%,transparent);background:color-mix(in srgb,var(--mtb-accent) 10%,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:11px;line-height:1.4;cursor:pointer;font-family:inherit;transition:background .15s,border-color .15s,transform .12s}',
        '.mtb-summary-chip:hover{background:color-mix(in srgb,var(--mtb-accent) 18%,transparent);border-color:color-mix(in srgb,var(--mtb-accent) 52%,transparent);transform:translateY(-1px)}',
        '.mtb-summary-chip strong{font-variant-numeric:tabular-nums;font-weight:700}',
        '.mtb-tagbar{padding:8px 20px;border-bottom:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 8%,transparent));display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex-shrink:0;background:color-mix(in srgb,currentColor 2%,transparent)}',
        '.mtb-search{width:170px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);border-radius:999px;padding:3.5px 10px;font-size:11.5px;font-family:inherit;outline:none}',
        '.mtb-search:focus{border-color:var(--dsw-alias-brand-primary,#6366f1)}',
        '.mtb-tagbar-label{font-size:11px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 60%,transparent));margin-left:4px}',
        '.mtb-notice{padding:9px 20px;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:color-mix(in srgb,#8b5cf6 14%,transparent);border-bottom:1px solid color-mix(in srgb,#8b5cf6 32%,transparent);color:var(--dsw-alias-label-primary,inherit)}',
        '.mtb-warn-hint{padding:8px 11px;border-radius:9px;font-size:12px;line-height:1.5;background:color-mix(in srgb,#8b5cf6 13%,transparent);border:1px solid color-mix(in srgb,#8b5cf6 38%,transparent);color:var(--dsw-alias-label-primary,inherit)}',
        '.mtb-tag{display:inline-flex;align-items:center;gap:4px;max-width:100%;border-radius:999px;padding:1.5px 8px;font-size:11px;line-height:1.5;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--mtb-tag-border,color-mix(in srgb,currentColor 22%,transparent));background:var(--mtb-tag-fill,color-mix(in srgb,currentColor 8%,transparent))}',
        '.mtb-tag-btn{cursor:pointer;font-family:inherit;transition:opacity .12s,transform .12s,box-shadow .12s}',
        '.mtb-tag-btn:hover{transform:translateY(-1px)}',
        '.mtb-tag-btn[data-active="true"]{box-shadow:0 0 0 1.5px var(--mtb-tag-border,currentColor);font-weight:600}',
        '.mtb-tag-x{border:0;background:transparent;color:inherit;cursor:pointer;padding:0 1px;font-size:12px;line-height:1;opacity:.75}',
        '.mtb-tag-x:hover{opacity:1}',
        '.mtb-tag[data-tag-tone="0"]{--mtb-tag-fill:#4e93e82e;--mtb-tag-border:#4e93e870}',
        '.mtb-tag[data-tag-tone="1"]{--mtb-tag-fill:#2ea36a2e;--mtb-tag-border:#2ea36a70}',
        '.mtb-tag[data-tag-tone="2"]{--mtb-tag-fill:#d08a2a2e;--mtb-tag-border:#d08a2a70}',
        '.mtb-tag[data-tag-tone="3"]{--mtb-tag-fill:#b456c82e;--mtb-tag-border:#b456c870}',
        '.mtb-tag[data-tag-tone="4"]{--mtb-tag-fill:#cf5f7a2e;--mtb-tag-border:#cf5f7a70}',
        '.mtb-tag[data-tag-tone="5"]{--mtb-tag-fill:#4a9fb52e;--mtb-tag-border:#4a9fb570}',
        '.mtb-tag[data-tag-tone="p0"]{--mtb-tag-fill:#ef444432;--mtb-tag-border:#ef444482;font-weight:600;font-variant-numeric:tabular-nums}',
        '.mtb-tag[data-tag-tone="p1"]{--mtb-tag-fill:#f59e0b32;--mtb-tag-border:#f59e0b82;font-weight:600;font-variant-numeric:tabular-nums}',
        '.mtb-tag[data-tag-tone="p2"]{--mtb-tag-fill:#3b82f630;--mtb-tag-border:#3b82f67a;font-weight:600;font-variant-numeric:tabular-nums}',
        '.mtb-tag[data-tag-tone="p3"]{--mtb-tag-fill:#64748b30;--mtb-tag-border:#64748b78;font-weight:600;font-variant-numeric:tabular-nums}',
        '.mtb-grid{flex:1;min-height:0;min-width:0;width:100%;box-sizing:border-box;overflow-x:auto;overflow-y:hidden;padding:14px 18px 14px;display:flex;flex-direction:row;gap:12px;align-items:stretch;scrollbar-width:auto;scrollbar-color:var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 32%,transparent)) color-mix(in srgb,currentColor 6%,transparent)}',
        '.mtb-grid::-webkit-scrollbar{height:10px}',
        '.mtb-grid::-webkit-scrollbar-track{background:color-mix(in srgb,currentColor 5%,transparent);border-radius:999px}',
        '.mtb-grid::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 32%,transparent));border-radius:999px;border:2px solid transparent;background-clip:content-box}',
        '.mtb-grid::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,currentColor 48%,transparent)}',
        '.mtb-col{flex:1 0 232px;min-width:232px;display:flex;flex-direction:column;min-height:0;max-height:100%;border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 4%,transparent));border:1px solid color-mix(in srgb,var(--mtb-accent) 22%,var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent)));border-top:3px solid var(--mtb-accent);transition:border-color .15s,box-shadow .15s,background .15s,flex-basis .15s}',
        '.mtb-col[data-collapsed="true"]{flex:0 0 44px;min-width:44px;max-width:44px;cursor:pointer;align-items:center;padding:10px 4px;gap:10px}',
        '.mtb-col-rail-title{writing-mode:vertical-rl;text-orientation:mixed;font-size:12px;font-weight:600;letter-spacing:.12em;color:var(--dsw-alias-label-secondary,inherit);user-select:none}',
        '.mtb-pan-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;cursor:pointer;font-size:11px;padding:0;flex-shrink:0}',
        '.mtb-pan-btn:hover{background:color-mix(in srgb,currentColor 13%,transparent)}',
        '.mtb-pan-btn[data-active="true"]{border-color:var(--dsw-alias-brand-primary,#6366f1);color:var(--dsw-alias-brand-primary,#6366f1);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6366f1) 12%,transparent)}',
        '.mtb-grid-wrap{flex:1;min-height:0;min-width:0;width:100%;position:relative;display:flex;overflow:hidden}',
        '.mtb-grid[data-panning="true"]{cursor:grabbing;user-select:none}',
        '.mtb-edge-pan{position:absolute;top:50%;transform:translateY(-50%);z-index:4;display:inline-flex;align-items:center;gap:4px;padding:7px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 22%,transparent));background:var(--dsw-alias-bg-layer-1,rgba(24,26,32,.92));color:var(--dsw-alias-label-primary,inherit);box-shadow:0 4px 14px rgba(0,0,0,.28);cursor:pointer;font-size:11.5px;font-weight:600;backdrop-filter:blur(8px);transition:transform .14s,background .14s}',
        '.mtb-edge-pan:hover{transform:translateY(-50%) scale(1.03)}',
        '.mtb-edge-pan-left{left:10px}',
        '.mtb-edge-pan-right{right:10px}',
        '.mtb-col[data-drop="true"]{border-color:var(--mtb-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--mtb-accent) 28%,transparent);background:color-mix(in srgb,var(--mtb-accent) 7%,var(--dsw-alias-bg-layer-2,transparent))}',
        '.mtb-col-head{padding:10px 12px;display:flex;align-items:center;gap:8px;flex-shrink:0;background:color-mix(in srgb,var(--mtb-accent) 8%,transparent);border-bottom:1px solid color-mix(in srgb,var(--mtb-accent) 16%,transparent)}',
        '.mtb-dot{width:8px;height:8px;border-radius:999px;background:var(--mtb-accent);flex-shrink:0}',
        '.mtb-dot[data-pulse="true"]{animation:mtb-pulse 2s cubic-bezier(.4,0,.6,1) infinite}',
        '.mtb-col-title{flex:1;min-width:0;font-size:13px;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.mtb-count{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;padding:1px 8px;border-radius:999px;flex-shrink:0;background:color-mix(in srgb,var(--mtb-accent) 16%,transparent);color:var(--dsw-alias-label-primary,inherit);border:1px solid color-mix(in srgb,var(--mtb-accent) 30%,transparent)}',
        '.mtb-col-body{flex:1;min-height:80px;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin}',
        '.mtb-empty{padding:26px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 55%,transparent));border:1px dashed color-mix(in srgb,var(--mtb-accent) 24%,transparent);border-radius:10px;background:color-mix(in srgb,var(--mtb-accent) 3%,transparent)}',
        '.mtb-card{position:relative;overflow:hidden;border-radius:10px;padding:10px 12px 9px 14px;display:flex;flex-direction:column;gap:6px;cursor:pointer;text-align:left;background:var(--dsw-alias-bg-base,color-mix(in srgb,currentColor 3%,transparent));border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 13%,transparent));transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease,opacity .12s ease}',
        '.mtb-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3.5px;background:var(--mtb-accent);opacity:.92;pointer-events:none}',
        '.mtb-card:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--mtb-accent) 48%,var(--dsw-alias-border-l3,transparent));box-shadow:var(--dsw-shadow-lv2,0 6px 16px -8px rgba(0,0,0,.22))}',
        '.mtb-card[data-status="running"]{border-color:color-mix(in srgb,var(--mtb-accent) 55%,transparent)}',
        '.mtb-card[data-compact="true"]{padding:7px 10px 7px 13px;gap:4px}',
        '.mtb-card[data-compact="true"]:hover{transform:none;box-shadow:none}',
        '.mtb-card[data-focused="true"],.mtb-card[data-selected="true"]{box-shadow:0 0 0 2px var(--mtb-accent)}',
        '.mtb-card[data-dragging="true"]{opacity:.45;transform:none}',
        '.mtb-card-title-row{display:flex;align-items:flex-start;gap:6px;min-width:0}',
        '.mtb-card-kind{flex:none;font-size:11px;font-weight:600;line-height:1.35;padding:1px 6px;border-radius:6px;background:color-mix(in srgb,var(--mtb-accent) 16%,transparent);color:var(--dsw-alias-label-primary,inherit);border:1px solid color-mix(in srgb,var(--mtb-accent) 34%,transparent)}',
        '.mtb-card-title{font-size:13px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,inherit);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;flex:1;min-width:0}',
        '.mtb-card[data-compact="true"] .mtb-card-title{-webkit-line-clamp:1;font-size:12px;font-weight:500}',
        '.mtb-card-tags{display:flex;flex-wrap:wrap;gap:4px;align-items:center}',
        '.mtb-card-excerpt{font-size:12px;line-height:1.48;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 66%,transparent));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
        '.mtb-card-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 68%,transparent))}',
        '.mtb-card-time{white-space:nowrap;font-variant-numeric:tabular-nums}',
        '.mtb-card-micro{display:inline-flex;align-items:center;gap:3px;padding:0 7px;height:19px;border-radius:999px;font-size:11px;line-height:1;background:color-mix(in srgb,currentColor 8%,transparent);border:1px solid color-mix(in srgb,currentColor 14%,transparent);color:var(--dsw-alias-label-primary,inherit);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mtb-card-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:22px;margin-top:2px}',
        '.mtb-card-foot-left{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}',
        '.mtb-card-foot-right{display:flex;align-items:center;gap:4px;flex-shrink:0;margin-left:auto}',
        '.mtb-result{--mtb-res-c:#94a3b8;display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;line-height:1.35;flex:none;color:var(--dsw-alias-label-primary,inherit);background:color-mix(in srgb,var(--mtb-res-c) 16%,transparent);border:1px solid color-mix(in srgb,var(--mtb-res-c) 46%,transparent)}',
        '.mtb-result::before{content:"";width:6px;height:6px;border-radius:999px;background:var(--mtb-res-c);flex-shrink:0}',
        '.mtb-result[data-tone="succeeded"]{--mtb-res-c:#10b981}',
        '.mtb-result[data-tone="review"]{--mtb-res-c:#8b5cf6}',
        '.mtb-result[data-tone="failed"]{--mtb-res-c:#ef4444}',
        '.mtb-result[data-tone="running"]{--mtb-res-c:#f59e0b}',
        '.mtb-result[data-tone="cancelled"]{--mtb-res-c:#94a3b8}',
        '.mtb-runs{font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent));font-variant-numeric:tabular-nums;white-space:nowrap}',
        '.mtb-spinner{width:11px;height:11px;border-radius:999px;border:1.8px solid color-mix(in srgb,var(--mtb-accent) 26%,transparent);border-top-color:var(--mtb-accent);animation:mtb-spin .85s linear infinite;flex-shrink:0}',
        '.mtb-icon-pill{display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,inherit);border-radius:7px;padding:2.5px 7px;font-size:11px;line-height:1.3;font-weight:500;cursor:pointer;font-family:inherit;transition:background .12s,border-color .12s,color .12s}',
        '.mtb-icon-pill:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 9%,transparent));color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent))}',
        '.mtb-icon-pill-confirm{color:var(--dsw-alias-label-primary,inherit);background:color-mix(in srgb,#10b981 18%,transparent);border-color:color-mix(in srgb,#10b981 48%,transparent);font-weight:600}',
        '.mtb-icon-pill-confirm:hover{background:color-mix(in srgb,#10b981 28%,transparent)}',
        '.mtb-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);border-radius:6px;cursor:pointer;padding:0;transition:background .12s,color .12s}',
        '.mtb-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 9%,transparent));color:var(--dsw-alias-label-primary,inherit)}',
        '.mtb-backdrop{position:absolute;inset:0;z-index:20;background:rgba(0,0,0,.32);display:flex;justify-content:flex-end;backdrop-filter:blur(1.5px)}',
        '.mtb-modal-backdrop{position:absolute;inset:0;z-index:25;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px)}',
        '.mtb-modal{width:min(540px,100%);max-height:86vh;display:flex;flex-direction:column;border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-base,#16181d);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));box-shadow:0 20px 56px rgba(0,0,0,.4)}',
        '.mtb-drawer{width:min(510px,94%);height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#16181d);color:var(--dsw-alias-label-primary,inherit);border-left:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent));box-shadow:-12px 0 36px rgba(0,0,0,.28)}',
        '.mtb-drawer-head{padding:14px 18px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent));flex-shrink:0;background:color-mix(in srgb,var(--mtb-accent) 8%,transparent)}',
        '.mtb-drawer-body{flex:1;min-height:0;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:14px}',
        '.mtb-drawer-sec{display:grid;gap:8px;padding:11px 13px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent));background:color-mix(in srgb,currentColor 3%,transparent)}',
        '.mtb-drawer-sec-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit);display:flex;align-items:center;justify-content:space-between;gap:8px}',
        '.mtb-drawer-foot{padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent));display:flex;flex-wrap:wrap;gap:7px;align-items:center;flex-shrink:0}',
        '.mtb-btn{border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));background:transparent;color:var(--dsw-alias-label-primary,inherit);border-radius:8px;padding:5px 11px;font-size:12px;line-height:1.3;font-weight:500;cursor:pointer;font-family:inherit;transition:background .12s,border-color .12s,color .12s}',
        '.mtb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent));border-color:var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 26%,transparent))}',
        '.mtb-btn:disabled{opacity:.5;cursor:not-allowed}',
        '.mtb-btn-accent{border-color:color-mix(in srgb,var(--mtb-accent) 46%,transparent);background:color-mix(in srgb,var(--mtb-accent) 18%,transparent);color:var(--dsw-alias-label-primary,inherit);font-weight:600}',
        '.mtb-btn-accent:hover:not(:disabled){background:color-mix(in srgb,var(--mtb-accent) 28%,transparent)}',
        '.mtb-btn-confirm{border-color:color-mix(in srgb,#10b981 48%,transparent);background:color-mix(in srgb,#10b981 18%,transparent);color:var(--dsw-alias-label-primary,inherit);font-weight:600}',
        '.mtb-btn-confirm:hover:not(:disabled){background:color-mix(in srgb,#10b981 28%,transparent)}',
        '.mtb-btn-ai{border-color:color-mix(in srgb,#8b5cf6 48%,transparent);background:color-mix(in srgb,#8b5cf6 14%,transparent);color:var(--dsw-alias-label-primary,inherit);font-weight:600}',
        '.mtb-btn-ai:hover:not(:disabled){background:color-mix(in srgb,#8b5cf6 24%,transparent)}',
        '.mtb-btn-danger{color:#ef4444;border-color:color-mix(in srgb,#ef4444 48%,transparent);background:color-mix(in srgb,#ef4444 12%,transparent)}',
        '.mtb-move{border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);border-radius:8px;padding:4px 8px;font-size:12px;line-height:1.3;cursor:pointer;font-family:inherit;outline:none}',
        '.mtb-form{margin:14px 20px 0;padding:16px;min-width:0;max-height:68vh;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent));border-radius:14px;background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 5%,transparent));display:grid;gap:12px;box-shadow:0 8px 24px -12px rgba(0,0,0,.24)}',
        '.mtb-tpl-grid{display:flex;flex-wrap:wrap;gap:6px}',
        '.mtb-tpl-pill{border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);border-radius:9px;padding:6px 11px;font-size:12px;line-height:1.3;cursor:pointer;font-family:inherit;transition:border-color .12s,background .12s}',
        '.mtb-tpl-pill:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#6366f1)}',
        '.mtb-tpl-pill[data-active="true"]{border-color:var(--dsw-alias-brand-primary,#6366f1);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6366f1) 16%,transparent);font-weight:600}',
        '.mtb-tpl-pill:disabled{opacity:.48;cursor:not-allowed}',
        '.mtb-sub-row{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent));background:var(--dsw-alias-bg-base,transparent)}',
        '.mtb-att-list{display:flex;flex-wrap:wrap;gap:8px}',
        '.mtb-att-card{display:inline-flex;align-items:center;gap:8px;padding:5px 9px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));background:var(--dsw-alias-bg-base,transparent);font-size:11.5px;max-width:240px}',
        '.mtb-att-link{color:inherit;text-decoration:none;font-weight:500;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.mtb-att-link:hover{text-decoration:underline;color:var(--dsw-alias-brand-primary,#6366f1)}',
        '.mtb-att-thumb{width:34px;height:34px;border-radius:6px;object-fit:cover;flex-shrink:0;border:1px solid var(--dsw-alias-border-l1,transparent)}',
        '.mtb-exec-row{display:grid;gap:4px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent));background:var(--dsw-alias-bg-base,transparent);font-size:11.5px}',
        '.mtb-review-panel{display:grid;gap:9px;padding:12px 14px;border-radius:12px;border:1px solid color-mix(in srgb,#8b5cf6 42%,transparent);background:color-mix(in srgb,#8b5cf6 9%,var(--dsw-alias-bg-layer-2,transparent))}',
        '.mtb-agent-cfg-list{display:grid;gap:8px}',
        '.mtb-agent-cfg-row{display:grid;gap:6px;padding:9px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 13%,transparent));background:color-mix(in srgb,currentColor 3.5%,transparent)}',
        '.mtb-agent-cfg-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px;font-weight:600}',
        '.mtb-agent-cfg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:7px}',
        '.mtb-archive-grid{flex:1;min-height:0;overflow:auto;padding:16px 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;align-content:start}',
      ].join('\n');
      if (!existing) document.head.appendChild(style);
    }

    function formatTaskTime(ts) {
      if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
      const diff = Math.max(0, Date.now() - ts);
      const min = Math.floor(diff / 60000);
      if (min < 1) return '刚刚';
      if (min < 60) return min + 'm';
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + 'h';
      const d = new Date(ts);
      return (d.getMonth() + 1) + '/' + d.getDate();
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function taskTagTone(name) {
      const pMatch = /^p([0-3])$/i.exec(String(name || '').trim());
      if (pMatch) return 'p' + pMatch[1];
      let hash = 0;
      for (const ch of String(name || '')) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
      return String(hash % 6);
    }

    function splitCardTitleKind(title) {
      const text = String(title || '');
      const match = /^\[([^\[\]\n]{1,24})\]\s*[:：]?\s*/.exec(text);
      if (!match) return { text };
      const kind = (match[1] || '').trim();
      const rest = text.slice(match[0].length).trim();
      return kind && rest ? { kind, text: rest } : { text };
    }

    function clientAmbiguityHint(title, description, prompt, hasAttachments, hasPr) {
      const cleanTitle = String(title || '').trim();
      const cleanDesc = String(description || '').trim();
      const cleanPrompt = String(prompt || '').trim();
      if (!cleanTitle || hasAttachments || hasPr) return '';
      const body = cleanDesc || (cleanPrompt !== cleanTitle ? cleanPrompt : '');
      const combined = (cleanTitle + ' ' + body).trim();
      if (/(看着办|随便|待定|待确认|不确定|再议|模糊|\bTBD\b|\bTODO\b|\?{2,}|？{2,})/i.test(combined)) {
        return '描述中包含「待定/不确定/看着办」等未明确表述，创建后将自动放入「待确认」列等待确认。';
      }
      const hasSpecific = /(https?:\/\/|#[0-9]+|PR\s*#?[0-9]+|\/[\w.-]+\/|\.[a-z]{1,5}\b|验收|步骤|目标|需求|修复|实现|新增|删除|接口|测试|指标|≥|<=|->|→)/i.test(combined);
      if (body.length === 0 && cleanTitle.replace(/\s+/g, '').length < 14 && !hasSpecific) {
        return '缺少任务描述且标题较简略，创建后将自动转入「待确认」列等待补充确认。';
      }
      if (body.length < 16 && /(?:^|[\s，,。！？!?])(帮我|请)?(看下|看看|弄一下|搞一下|处理一下|优化一下|改一下|修一下|研究一下|完善一下|整理一下|查一下|调整一下|跟进一下|想想办法)(?:$|[\s，,。！？!?])/.test(combined) && !hasSpecific) {
        return '任务描述较为宽泛、缺少明确对象或验收标准，创建后将自动转入「待确认」列等待确认。';
      }
      return '';
    }

    function flattenModelCatalog(raw) {
      const cat = raw?.catalog ?? raw;
      const out = [];
      const groups = Array.isArray(cat?.groups) ? cat.groups : [];
      for (const group of groups) {
        const provider = group?.id || group?.provider;
        if (typeof provider !== 'string' || !provider) continue;
        for (const item of Array.isArray(group.models) ? group.models : []) {
          if (!item || typeof item.id !== 'string' || !item.id) continue;
          const route = provider + '/' + item.id;
          const efforts = Array.isArray(item.reasoning?.efforts)
            ? item.reasoning.efforts.map(e => typeof e === 'string' ? e : e?.id).filter(Boolean)
            : [];
          out.push({
            route,
            provider,
            id: item.id,
            label: (item.label || item.name || item.id) + ' (' + provider + ')',
            efforts,
          });
        }
      }
      const def = cat?.default?.provider && cat?.default?.model ? cat.default.provider + '/' + cat.default.model : '';
      return { options: out, defaultRoute: def };
    }

    const PRIORITY_TAGS = ['P0', 'P1', 'P2', 'P3'];
    const DEFAULT_REASONING_EFFORTS = [
      { id: 'low', label: '低 (low)' },
      { id: 'medium', label: '中 (medium)' },
      { id: 'high', label: '高 (high)' },
      { id: 'xhigh', label: '极高 (xhigh)' },
    ];
    const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const EXT_MEDIA_TYPES = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
      pdf: 'application/pdf', json: 'application/json', md: 'text/markdown', txt: 'text/plain',
      log: 'text/plain', csv: 'text/csv', patch: 'text/x-diff', diff: 'text/x-diff',
      yaml: 'text/yaml', yml: 'text/yaml', html: 'text/html', xml: 'application/xml', zip: 'application/zip',
    };
    const MAX_SINGLE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
    const PARSE_MODEL_STORAGE_KEY = 'dsh.taskBoard.parseModel.v1';

    function resolveClientApiUrl(relativePath) {
      try {
        const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : window.location.href;
        return new URL(relativePath, base).toString();
      } catch {
        return relativePath;
      }
    }

    function inferAttachmentMediaType(file) {
      const raw = String(file?.type || '').trim().toLowerCase();
      if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(raw)) return raw;
      const name = String(file?.name || '').trim();
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
      return EXT_MEDIA_TYPES[ext] || 'application/octet-stream';
    }

    function serializeAttachmentForWire(att) {
      if (!att || typeof att !== 'object') return att;
      return {
        kind: att.kind,
        attachmentId: att.attachmentId,
        name: att.name,
        bytes: att.bytes,
        mediaType: String(att.mediaType || 'application/octet-stream').toLowerCase(),
        sha256: String(att.sha256 || '').toLowerCase(),
        ...(att.kind === 'image' ? { width: att.width, height: att.height } : {}),
      };
    }

    function attachmentHref(taskId, att, previewMap) {
      if (!att?.attachmentId) return '';
      const localUrl = previewMap?.get?.(att.attachmentId);
      if (localUrl) return localUrl;
      if (taskId) {
        return resolveClientApiUrl('marshal/tasks/attachment?taskId=' + encodeURIComponent(taskId) + '&id=' + encodeURIComponent(att.attachmentId));
      }
      if (att.kind === 'image') {
        return resolveClientApiUrl('api/task-board/attachments/image?id=' + encodeURIComponent(att.attachmentId));
      }
      return '';
    }

    async function uploadAttachmentFiles(fileList, previewMap) {
      const files = Array.from(fileList || []).slice(0, 8);
      if (files.length === 0) return [];
      const uploaded = [];
      for (const file of files) {
        if (typeof file.size === 'number' && file.size > MAX_SINGLE_ATTACHMENT_BYTES) {
          throw new Error('文件「' + (file.name || 'attachment') + '」超过单文件 10 MB 限制');
        }
        const mediaType = inferAttachmentMediaType(file);
        const kind = IMAGE_MEDIA_TYPES.has(mediaType) ? 'image' : 'file';
        const qs = new URLSearchParams({ kind, name: file.name || 'attachment', mediaType });
        const uploadUrl = resolveClientApiUrl('api/task-board/attachments/upload?' + qs.toString());
        const resp = await fetch(uploadUrl, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data?.attachment) {
          throw new Error(data?.error || data?.message || ('上传失败 HTTP ' + resp.status));
        }
        const normalized = serializeAttachmentForWire(data.attachment);
        if (normalized.kind === 'image' && previewMap && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          try { previewMap.set(normalized.attachmentId, URL.createObjectURL(file)); } catch {}
        }
        uploaded.push(normalized);
      }
      return uploaded;
    }

    const TASK_PERMISSION_LABELS = {
      'read-only': '只读',
      'workspace-write': '工作区可写',
      'danger-full-access': '完全权限',
    };

    const TASK_RESULT_LABELS = {
      succeeded: '已完成',
      failed: '失败',
      cancelled: '已取消',
    };

    const PERMISSION_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };

    function TaskBoardPage({ openSession, openTaskRoom, focusedTask, openNativeBoard, onOpenRosters }) {
      const [tasks, setTasks] = React.useState(null);
      const [sessionDefaultPerm, setSessionDefaultPerm] = React.useState('read-only');
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [formOpen, setFormOpen] = React.useState(false);
      const [parseOpen, setParseOpen] = React.useState(false);
      const [parseInput, setParseInput] = React.useState('');
      const [parseModel, setParseModel] = React.useState(() => {
        try { return globalThis.localStorage?.getItem(PARSE_MODEL_STORAGE_KEY) || ''; } catch { return ''; }
      });
      const [parseBusy, setParseBusy] = React.useState(false);
      const [parseError, setParseError] = React.useState('');
      const [modelOptions, setModelOptions] = React.useState([]);
      const [defaultModelRoute, setDefaultModelRoute] = React.useState('');

      const [title, setTitle] = React.useState('');
      const [description, setDescription] = React.useState('');
      const [formPrompt, setFormPrompt] = React.useState('');
      const [formTags, setFormTags] = React.useState([]);
      const [newTagDraft, setNewTagDraft] = React.useState('');
      const [formParentId, setFormParentId] = React.useState('');
      const [formPermission, setFormPermission] = React.useState('');
      const [formModel, setFormModel] = React.useState('');
      const [formEffort, setFormEffort] = React.useState('');
      const [formReuseSession, setFormReuseSession] = React.useState(false);
      const [formAttachments, setFormAttachments] = React.useState([]);
      const [uploading, setUploading] = React.useState(false);
      const [assignedAgent, setAssignedAgent] = React.useState('');
      const [orchestrationMode, setOrchestrationMode] = React.useState('plain');

      const [confirmId, setConfirmId] = React.useState('');
      const [drawerReviseNote, setDrawerReviseNote] = React.useState('');
      React.useEffect(() => { ensureTaskRoomStyles(); }, []);
      const [dragTaskId, setDragTaskId] = React.useState('');
      const [dropCol, setDropCol] = React.useState('');
      const [compactCards, setCompactCards] = React.useState(false);
      const [showFlowGuide, setShowFlowGuide] = React.useState(false);
      const [collapsedCols, setCollapsedCols] = React.useState(() => {
        try { const raw = JSON.parse(globalThis.localStorage?.getItem('marshal.board.collapsedCols') || '[]'); return Array.isArray(raw) ? raw : []; } catch { return []; }
      });
      const gridRef = React.useRef(null);
      const panDragRef = React.useRef(null);
      const [panning, setPanning] = React.useState(false);
      const [scrollEdge, setScrollEdge] = React.useState({ left: false, right: false });
      const syncScrollEdges = React.useCallback(() => {
        const el = gridRef.current;
        if (!el) return;
        const maxLeft = Math.max(0, el.scrollWidth - el.clientWidth);
        const left = el.scrollLeft > 8;
        const right = maxLeft > 8 && el.scrollLeft < maxLeft - 8;
        setScrollEdge(prev => (prev.left === left && prev.right === right ? prev : { left, right }));
      }, []);
      React.useEffect(() => {
        syncScrollEdges();
        const el = gridRef.current;
        if (!el) return;
        const onScroll = () => syncScrollEdges();
        el.addEventListener('scroll', onScroll, { passive: true });
        let ro;
        if (typeof ResizeObserver === 'function') {
          ro = new ResizeObserver(() => syncScrollEdges());
          ro.observe(el);
        }
        window.addEventListener('resize', onScroll);
        return () => {
          el.removeEventListener('scroll', onScroll);
          window.removeEventListener('resize', onScroll);
          ro?.disconnect();
        };
      }, [syncScrollEdges, collapsedCols]);
      const toggleCollapseCol = key => {
        setCollapsedCols(prev => {
          const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
          try { globalThis.localStorage?.setItem('marshal.board.collapsedCols', JSON.stringify(next)); } catch {}
          return next;
        });
      };
      const collapseEmptyCols = emptyKeys => {
        setCollapsedCols(prev => {
          const allEmptyCollapsed = emptyKeys.length > 0 && emptyKeys.every(k => prev.includes(k));
          const next = allEmptyCollapsed ? prev.filter(k => !emptyKeys.includes(k)) : [...new Set([...prev, ...emptyKeys])];
          try { globalThis.localStorage?.setItem('marshal.board.collapsedCols', JSON.stringify(next)); } catch {}
          return next;
        });
      };
      const expandAllCols = () => {
        setCollapsedCols([]);
        try { globalThis.localStorage?.setItem('marshal.board.collapsedCols', '[]'); } catch {}
      };
      const panBoard = delta => {
        const el = gridRef.current;
        if (el) el.scrollBy({ left: delta, behavior: 'smooth' });
      };
      const handleGridMouseDown = event => {
        if (event.button !== 0 || dragTaskId) return;
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('button,input,textarea,select,a,[draggable="true"],.mtb-card')) return;
        const el = gridRef.current;
        if (!el || el.scrollWidth <= el.clientWidth + 4) return;
        panDragRef.current = { startX: event.clientX, startLeft: el.scrollLeft };
        setPanning(true);
        const onMove = moveEvent => {
          const state = panDragRef.current;
          if (!state) return;
          el.scrollLeft = state.startLeft - (moveEvent.clientX - state.startX);
        };
        const onUp = () => {
          panDragRef.current = null;
          setPanning(false);
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      };
      const handleGridWheel = event => {
        const el = gridRef.current;
        if (!el || el.scrollWidth <= el.clientWidth + 4) return;
        if (event.shiftKey && Math.abs(event.deltaY) > 0) {
          el.scrollLeft += event.deltaY;
          event.preventDefault();
          return;
        }
        const colBody = event.target && typeof event.target.closest === 'function' ? event.target.closest('.mtb-col-body') : null;
        const colCanScrollY = colBody && colBody.scrollHeight > colBody.clientHeight + 2;
        if (!colCanScrollY && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          el.scrollLeft += event.deltaY;
          event.preventDefault();
        }
      };
      const handleGridDragOver = event => {
        if (!dragTaskId) return;
        const el = gridRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const edge = 76;
        if (event.clientX > rect.right - edge) el.scrollLeft += 18;
        else if (event.clientX < rect.left + edge) el.scrollLeft -= 18;
      };
      const [showArchive, setShowArchive] = React.useState(false);
      const [activeTag, setActiveTag] = React.useState('');
      const [searchQuery, setSearchQuery] = React.useState('');
      const [selectedId, setSelectedId] = React.useState('');
      const [drawerEditing, setDrawerEditing] = React.useState(false);
      const [editTitle, setEditTitle] = React.useState('');
      const [editDesc, setEditDesc] = React.useState('');
      const [editPrompt, setEditPrompt] = React.useState('');
      const [editPerm, setEditPerm] = React.useState('');
      const [editModel, setEditModel] = React.useState('');
      const [editEffort, setEditEffort] = React.useState('');
      const [editReuseSession, setEditReuseSession] = React.useState(false);
      const [editFreezeGoal, setEditFreezeGoal] = React.useState('');
      const [editSteerNow, setEditSteerNow] = React.useState(true);
      const [drawerTagDraft, setDrawerTagDraft] = React.useState('');
      const [newSubtaskTitle, setNewSubtaskTitle] = React.useState('');
      const [linkChildId, setLinkChildId] = React.useState('');
      const [cronDraft, setCronDraft] = React.useState('');
      const [cronMode, setCronMode] = React.useState('cron');
      const [onceDraft, setOnceDraft] = React.useState('');
      const [cronEnabled, setCronEnabled] = React.useState(false);

      const [catalog, setCatalog] = React.useState(null);
      const [catalogError, setCatalogError] = React.useState('');
      const [leaderId, setLeaderId] = React.useState('');
      const [workspaceId, setWorkspaceId] = React.useState('');
      const [workspaces, setWorkspaces] = React.useState([]);
      const [rosters, setRosters] = React.useState({});
      const selectedLeader = catalog?.leaders.find(item => item.id === leaderId);
      const workspace = workspaceId || (selectedLeader && !selectedLeader.global ? selectedLeader.workspaceId : '');
      const [choice, setChoice] = React.useState('leader');
      const [templateId, setTemplateId] = React.useState('pr-review');
      const [prUrl, setPrUrl] = React.useState('');
      const [editing, setEditing] = React.useState('');
      const [plan, setPlan] = React.useState(null);
      const [codexModels, setCodexModels] = React.useState([]);
      const [explicitCode, setExplicitCode] = React.useState(false);
      const [formAgentConfigs, setFormAgentConfigs] = React.useState({});
      const selectedTemplate = plan?.templateId ?? (choice === 'template' ? templateId : choice === 'none' ? 'none' : '');
      const recommendedTemplate = selectedTemplate === 'none' ? catalog?.plainTemplate : catalog?.templates.find(item => item.id === selectedTemplate);
      const codeWork = selectedTemplate === 'development' || (selectedTemplate !== 'pr-review' && (plan?.codeWork ?? explicitCode));
      const roleChoices = codeWork ? recommendedTemplate?.codingRoles : recommendedTemplate?.roles;
      const candidates = catalog?.leaders.filter(item => (item.global || item.workspaceId === workspace) && item.id !== leaderId) ?? [];
      const groupId = codeWork && selectedTemplate ? 'delivery' : recommendedTemplate?.groupTemplate;
      const group = catalog?.groupTemplates?.find(item => item.id === groupId);
      const template = catalog?.templates.find(item => item.id === templateId);
      const requiresPr = orchestrationMode === 'template' && leaderId !== '' && choice === 'template' && templateId === 'pr-review';

      const allTasks = Array.isArray(tasks) ? tasks : [];
      const allActive = allTasks.filter(task => task.archivedAt === undefined);
      const archivedTasks = allTasks.filter(task => task.archivedAt !== undefined);
      const knownTags = React.useMemo(() => {
        const seen = new Set();
        const out = [];
        for (const task of allActive) {
          for (const tag of task.tags ?? []) {
            if (tag?.name && !seen.has(tag.name)) { seen.add(tag.name); out.push(tag); }
          }
        }
        return out;
      }, [allActive]);
      const q = searchQuery.trim().toLowerCase();
      const list = allActive.filter(task => {
        if (activeTag && !(task.tags ?? []).some(tag => tag.name === activeTag)) return false;
        if (q) {
          const hay = [task.ticketNo, task.title, task.description, ...(task.tags ?? []).map(t => t.name)].filter(Boolean).join(' ').toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      const subtaskStats = React.useMemo(() => {
        const map = new Map();
        for (const task of allActive) {
          if (!task.parentId) continue;
          const entry = map.get(task.parentId) ?? { total: 0, done: 0, running: 0, failed: 0 };
          entry.total += 1;
          if (task.status === 'done' || task.status === 'review') entry.done += 1;
          else if (task.status === 'running') entry.running += 1;
          else if (task.status === 'failed') entry.failed += 1;
          map.set(task.parentId, entry);
        }
        return map;
      }, [allActive]);
      const columns = [
        { key: 'backlog', label: '待规划', accent: '#7c8798', empty: '暂无待规划任务' },
        { key: 'todo', label: '待办', accent: 'var(--dsw-alias-state-business-primary, #3b82f6)', empty: '暂无待办任务' },
        { key: 'running', label: '进行中', accent: 'var(--dsw-alias-state-warn-primary, #f59e0b)', empty: '暂无进行中任务', pulse: true },
        { key: 'review', label: '待确认', accent: '#8b5cf6', empty: '暂无待确认任务' },
        { key: 'done', label: '已完成', accent: 'var(--dsw-alias-state-success-primary, #10b981)', empty: '暂无已完成任务' },
        { key: 'failed', label: '已失败', accent: 'var(--dsw-alias-state-error-primary, #ef4444)', empty: '暂无失败任务' },
      ];
      const knownStatuses = new Set(columns.map(c => c.key));

      const load = async (isAlive = () => true) => {
        try {
          const data = await fetchJson('marshal/tasks/state', undefined, true);
          if (!isAlive()) return;
          setTasks(data.tasks || []);
          if (typeof data.sessionDefaultPermission === 'string') setSessionDefaultPerm(data.sessionDefaultPermission);
          setError('');
        }
        catch (e) { if (isAlive()) setError(friendlyError(e, '任务看板')); }
      };
      React.useEffect(() => {
        ensureTaskBoardStyles();
        let alive = true;
        const unsubscribe = subscribeMarshalEvents(['ready', 'tasks.changed', 'incidents.changed', 'agents.changed', 'room.message'],
          () => load(() => alive), { initial: true, debounceMs: 80 });
        void fetchJson('marshal/tasks/orchestration', undefined, true)
          .then(data => {
            setCatalog(data);
            if (Array.isArray(data?.codexModels) && data.codexModels.length > 0) {
              setCodexModels(data.codexModels);
            }
          }).catch(() => setCatalogError('编排配置暂不可用。'));
        void fetchJson('marshal/task-rooms/workspaces', undefined, true).then(data => {
          const realWs = (data.workspaces || []).filter(item => !isPseudoAgentWorkspace(item));
          setWorkspaces(realWs);
          if (realWs.length === 1) setWorkspaceId(realWs[0].id);
        }).catch(() => {});
        void fetchJson('marshal/rosters/state').then(data => {
          setRosters(data?.rosters || {});
        }).catch(() => {});
        void fetch('api/task-board/model-catalog', { credentials: 'same-origin' })
          .then(r => r.ok ? r.json() : null)
          .then(raw => {
            if (!raw) return;
            const flat = flattenModelCatalog(raw);
            setModelOptions(flat.options);
            setDefaultModelRoute(flat.defaultRoute);
            setParseModel(cur => cur || flat.defaultRoute || flat.options[0]?.route || '');
          }).catch(() => {});
        return () => { alive = false; unsubscribe(); };
      }, []);

      React.useEffect(() => {
        if (!selectedId && !parseOpen) return undefined;
        const onKey = event => {
          if (event.key === 'Escape') {
            if (parseOpen) setParseOpen(false);
            else { setSelectedId(''); setConfirmId(''); setDrawerEditing(false); }
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [selectedId, parseOpen]);

      const selectedTask = selectedId ? allTasks.find(item => item.id === selectedId) : undefined;
      React.useEffect(() => {
        setDrawerEditing(false);
        setDrawerTagDraft('');
        setNewSubtaskTitle('');
        setLinkChildId('');
        if (selectedTask) {
          setEditTitle(selectedTask.title || '');
          setEditDesc(selectedTask.description || '');
          setEditPrompt(selectedTask.prompt || '');
          setEditPerm(selectedTask.permission || '');
          setEditModel(selectedTask.model || '');
          setEditEffort(selectedTask.reasoningEffort || '');
          setEditReuseSession(selectedTask.reuseSession === true);
          setEditFreezeGoal(selectedTask.freeze?.goal || '');
          setEditSteerNow(true);
          setCronDraft(selectedTask.schedule?.cron || '');
          setCronMode(selectedTask.schedule?.mode === 'once' ? 'once' : 'cron');
          setOnceDraft(selectedTask.schedule?.at ? new Date(selectedTask.schedule.at - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
          setCronEnabled(selectedTask.schedule?.enabled === true);
        }
      }, [selectedId]);

      const focusAvailable = allActive.some(item => item.id === focusedTask);
      React.useEffect(() => {
        if (focusedTask && focusAvailable) document.getElementById('marshal-ticket-' + focusedTask)?.scrollIntoView({ block: 'nearest' });
      }, [focusedTask, focusAvailable]);

      const effortsForModel = route => {
        const hit = modelOptions.find(m => m.route === route || m.id === route);
        if (hit && hit.efforts.length > 0) {
          return hit.efforts.map(id => DEFAULT_REASONING_EFFORTS.find(d => d.id === id) ?? { id, label: id });
        }
        return DEFAULT_REASONING_EFFORTS;
      };

      const thinkingModeOptions = (route, defaultEffort = '', currentVal = '') => {
        const base = [
          { id: '', label: '思考：跟随默认' + (defaultEffort ? ' (' + defaultEffort + ')' : '') },
          { id: 'off', label: '思考：关闭 (直出)' },
          ...effortsForModel(route).map(opt => ({ id: opt.id, label: '思考：' + opt.label })),
        ];
        if (currentVal && !base.some(o => o.id === currentVal)) {
          base.push({ id: currentVal, label: '思考：' + currentVal });
        }
        return base;
      };

      const codexThinkingOptions = (codexSlotValue, currentVal = '') => {
        const matched = codexModels.find(m => m.id === codexSlotValue || m.model === codexSlotValue) ?? codexModels[0];
        const declared = Array.isArray(matched?.reasoningEfforts) && matched.reasoningEfforts.length > 0
          ? matched.reasoningEfforts.map(id => DEFAULT_REASONING_EFFORTS.find(d => d.id === id) ?? { id, label: id })
          : DEFAULT_REASONING_EFFORTS;
        const base = [
          { id: '', label: '思考：跟随默认' },
          { id: 'off', label: '思考：关闭 (直出)' },
          ...declared.map(opt => ({ id: opt.id, label: '思考：' + opt.label })),
        ];
        if (currentVal && !base.some(o => o.id === currentVal)) {
          base.push({ id: currentVal, label: '思考：' + currentVal });
        }
        return base;
      };

      const modelSelectOptions = (defaultModelHint = '', currentVal = '') => {
        const opts = [
          { route: '', label: defaultModelHint ? '默认 (' + defaultModelHint + ')' : '跟随智能体默认模型' },
          ...modelOptions,
        ];
        if (currentVal && !opts.some(o => o.route === currentVal)) {
          opts.push({ route: currentVal, label: currentVal + ' (已指定)' });
        }
        return opts;
      };

      const cleanClientAgentConfigs = raw => {
        if (!raw || typeof raw !== 'object') return undefined;
        const out = {};
        for (const [slot, cfg] of Object.entries(raw)) {
          if (!cfg || typeof cfg !== 'object') continue;
          const m = typeof cfg.model === 'string' ? cfg.model.trim() : '';
          const r = typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort.trim() : '';
          if (m || r) out[slot] = { ...(m ? { model: m } : {}), ...(r ? { reasoningEffort: r } : {}) };
        }
        return Object.keys(out).length > 0 ? out : undefined;
      };

      const setSlotConfig = (slot, patch) => {
        setFormAgentConfigs(prev => {
          const cur = prev?.[slot] ?? {};
          const nextSlot = { ...cur, ...patch };
          if (!nextSlot.model) delete nextSlot.model;
          if (!nextSlot.reasoningEffort) delete nextSlot.reasoningEffort;
          const next = { ...(prev ?? {}) };
          if (Object.keys(nextSlot).length === 0) delete next[slot];
          else next[slot] = nextSlot;
          return next;
        });
      };

      const buildLocalPlanFor = (tplId, useCodeWork, activeLeaderId, wsId) => {
        if (!catalog || !tplId) return null;
        const tplMeta = tplId === 'none' ? catalog.plainTemplate : catalog.templates?.find(t => t.id === tplId);
        if (!tplMeta) return null;
        const isCode = tplId === 'development' || (tplId !== 'pr-review' && Boolean(useCodeWork));
        const slots = (isCode ? tplMeta.codingRoles : tplMeta.roles) ?? [];
        const pool = (catalog.leaders ?? []).filter(item => (item.global || !wsId || item.workspaceId === wsId) && item.id !== activeLeaderId);
        const used = new Set([activeLeaderId]);
        const members = {};
        for (const slot of slots) {
          if (slot.id === 'codexCritic') {
            members[slot.id] = '@codex';
            continue;
          }
          const avail = pool.filter(m => !used.has(m.id) && (slot.id !== 'coder' || ['workspace-write', 'danger-full-access'].includes(m.permission)));
          if (avail[0]) {
            members[slot.id] = avail[0].id;
            used.add(avail[0].id);
          } else if (slot.id === 'critic') {
            members[slot.id] = '@dsh';
          }
        }
        return {
          templateId: tplId,
          groupTemplate: isCode ? 'delivery' : (tplMeta.groupTemplate ?? 'free'),
          codeWork: isCode,
          members,
          codex: {
            coding: isCode ? 'auto' : null,
            review: (isCode || tplId === 'pr-review') ? 'auto' : null,
          },
        };
      };

      const previewUrlsRef = React.useRef(new Map());
      React.useEffect(() => () => {
        for (const blobUrl of previewUrlsRef.current.values()) {
          try { URL.revokeObjectURL(blobUrl); } catch {}
        }
        previewUrlsRef.current.clear();
      }, []);

      const uploadFiles = async (fileList, onUploaded) => {
        const files = Array.from(fileList || []).slice(0, 8);
        if (files.length === 0) return;
        setUploading(true);
        setError('');
        try {
          const uploaded = await uploadAttachmentFiles(files, previewUrlsRef.current);
          if (uploaded.length > 0) {
            onUploaded(uploaded);
            setNotice('已上传 ' + uploaded.length + ' 个附件：' + uploaded.map(item => item.name).join('、'));
          }
        }
        catch (e) { setError('上传附件失败：' + (e.message || e)); }
        finally { setUploading(false); }
      };

      const runAiParse = async () => {
        const text = parseInput.trim();
        if (!text || parseBusy) return;
        const route = parseModel || defaultModelRoute || modelOptions[0]?.route || '';
        if (!route) { setParseError('未检测到可用的解析模型，请先在 DSH 中配置模型。'); return; }
        setParseBusy(true);
        setParseError('');
        try {
          try { globalThis.localStorage?.setItem(PARSE_MODEL_STORAGE_KEY, route); } catch {}
          const resp = await fetch('api/task-board/parse', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, model: route }),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || !data?.draft) throw new Error(data?.error || ('解析失败 HTTP ' + resp.status));
          setTitle(data.draft.title || '');
          setDescription(data.draft.description || '');
          setFormPrompt(data.draft.prompt || '');
          setPlan(null);
          setParseOpen(false);
          setFormOpen(true);
          setNotice('AI 已解析任务草稿，可继续补充标签、Agent Leader、模型或直接创建。');
        }
        catch (e) { setParseError('AI 解析失败：' + (e.message || e)); }
        finally { setParseBusy(false); }
      };

      const choiceBody = () => {
        const cleanedConfigs = cleanClientAgentConfigs(formAgentConfigs);
        return {
          leaderId, choice, codeWork: explicitCode || undefined,
          ...(workspace ? { workspaceId: workspace } : {}),
          ...(choice === 'template' ? { templateId } : {}),
          ...(choice !== 'none' && prUrl.trim() ? { prUrl: prUrl.trim() } : {}),
          ...(cleanedConfigs ? { agentConfigs: cleanedConfigs } : {}),
        };
      };
      const recommend = async () => {
        if (busy || !leaderId || !title.trim()) return;
        if (requiresPr && !prUrl.trim()) { setError('请填写要审查的 PR 链接'); return; }
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/preview', {
            title: title.trim(), description: description.trim(), orchestration: choiceBody(),
          }, true);
          setPlan(result.plan);
          if (result.plan?.agentConfigs) setFormAgentConfigs(result.plan.agentConfigs);
          if (Array.isArray(result.codexModels) && result.codexModels.length > 0) setCodexModels(result.codexModels);
          setExplicitCode(result.plan.codeWork && result.plan.templateId !== 'development');
        }
        catch (e) { setError('推荐分工失败，' + (e.message || e)); }
        finally { setBusy(false); }
      };
      const cancelForm = () => {
        setFormOpen(false);
        if (editing) {
          setEditing('');
          setTitle('');
          setDescription('');
          setFormPrompt('');
          setFormTags([]);
          setNewTagDraft('');
          setFormParentId('');
          setFormPermission('');
          setFormModel('');
          setFormEffort('');
          setFormReuseSession(false);
          setFormAttachments([]);
          setAssignedAgent('');
          setOrchestrationMode('plain');
          setLeaderId('');
          setPlan(null);
          setFormAgentConfigs({});
          setChoice('leader');
          setPrUrl('');
          setExplicitCode(false);
        }
      };
      const edit = task => {
        const workflow = task.workflow;
        setSelectedId('');
        setEditing(task.id);
        setTitle(task.title);
        setDescription(task.description ?? '');
        setFormPrompt(task.prompt ?? '');
        setFormTags((task.tags ?? []).map(t => t.name).filter(n => !n.startsWith('智能体:')));
        setNewTagDraft('');
        setFormParentId(task.parentId ?? '');
        setFormPermission(task.permission ?? '');
        setFormModel(task.model ?? '');
        setFormEffort(task.reasoningEffort ?? '');
        setFormReuseSession(task.reuseSession === true);
        setFormAttachments(Array.isArray(task.attachments) ? task.attachments : []);
        if (workflow) {
          setWorkspaceId(workflow.workspaceId);
          setLeaderId(workflow.leaderId);
          setAssignedAgent(workflow.leaderId);
          setOrchestrationMode(workflow.choice === 'template' ? 'template' : workflow.choice === 'none' ? 'none' : 'leader');
          setChoice(workflow.choice);
          const effTpl = workflow.templateId ?? workflow.plan?.templateId ?? 'pr-review';
          setTemplateId(effTpl);
          setPrUrl(workflow.prUrl ?? '');
          const mergedCfg = { ...(workflow.agentConfigs ?? {}), ...(workflow.plan?.agentConfigs ?? {}) };
          setFormAgentConfigs(mergedCfg);
          setPlan(workflow.planConfirmed && workflow.plan ? workflow.plan : (workflow.choice !== 'leader' ? buildLocalPlanFor(workflow.choice === 'none' ? 'none' : effTpl, workflow.plan?.codeWork, workflow.leaderId, workflow.workspaceId) : null));
          setExplicitCode(Boolean(workflow.plan?.codeWork && workflow.plan?.templateId !== 'development'));
        } else {
          const fallbackWs = task.taskRoom?.workspaceId || (workspaces.length === 1 ? workspaces[0].id : '');
          const tagAgentName = ((task.tags ?? []).map(t => t.name).find(n => n.startsWith('智能体:')) || '').slice(4);
          const matchedLeader = (catalog?.leaders ?? []).find(l => l.name === tagAgentName) ?? (catalog?.leaders ?? [])[0];
          const initWs = fallbackWs || (matchedLeader && !matchedLeader.global ? matchedLeader.workspaceId : '');
          setWorkspaceId(initWs);
          setLeaderId(matchedLeader?.id ?? '');
          setAssignedAgent(matchedLeader?.id ?? '');
          setOrchestrationMode(matchedLeader ? 'leader' : 'plain');
          setChoice('leader');
          setTemplateId('development');
          setPrUrl('');
          setFormAgentConfigs({});
          setPlan(null);
          setExplicitCode(false);
        }
        setError('');
        setFormOpen(true);
      };
      const pickOrchestrationMode = (mode, tplId) => {
        setExplicitCode(false);
        setOrchestrationMode(mode);
        if (mode === 'plain') {
          setPlan(null);
          setLeaderId('');
          setChoice('leader');
          return;
        }
        const availLeaders = catalog?.leaders ?? [];
        const picked = assignedAgent || leaderId || availLeaders[0]?.id || '';
        if (picked) { setLeaderId(picked); setAssignedAgent(picked); }
        if (mode === 'leader') {
          setChoice('leader');
          setPlan(null);
        } else if (mode === 'template') {
          const targetTpl = tplId || templateId;
          setChoice('template');
          if (tplId) setTemplateId(tplId);
          setPlan(picked ? buildLocalPlanFor(targetTpl, false, picked, workspaceId) : null);
        } else if (mode === 'none') {
          setChoice('none');
          setPlan(picked ? buildLocalPlanFor('none', false, picked, workspaceId) : null);
        }
      };
      const handleAssignAgent = id => {
        setAssignedAgent(id);
        if (orchestrationMode !== 'plain') {
          setLeaderId(id);
          if (orchestrationMode === 'template') setPlan(id ? buildLocalPlanFor(templateId, explicitCode, id, workspaceId) : null);
          else if (orchestrationMode === 'none') setPlan(id ? buildLocalPlanFor('none', explicitCode, id, workspaceId) : null);
          else setPlan(null);
        }
      };
      const handleSelectWorkspace = nextWsId => {
        setWorkspaceId(nextWsId);
        const roster = nextWsId ? rosters[nextWsId] : undefined;
        let effLeader = leaderId;
        if (roster?.leaderId && catalog?.leaders?.some(item => item.id === roster.leaderId)) {
          effLeader = roster.leaderId;
          setAssignedAgent(roster.leaderId);
          if (orchestrationMode !== 'plain') setLeaderId(roster.leaderId);
          setNotice('已套用该工作区默认班底 Leader');
        }
        if (orchestrationMode === 'template' && effLeader) setPlan(buildLocalPlanFor(templateId, explicitCode, effLeader, nextWsId));
        else if (orchestrationMode === 'none' && effLeader) setPlan(buildLocalPlanFor('none', explicitCode, effLeader, nextWsId));
        else setPlan(null);
      };
      const toggleFormTag = name => {
        const clean = String(name || '').trim();
        if (!clean) return;
        setFormTags(prev => prev.includes(clean) ? prev.filter(t => t !== clean) : [...prev, clean]);
      };
      const addNewFormTag = () => {
        const parts = newTagDraft.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        if (parts.length === 0) return;
        setFormTags(prev => {
          const next = [...prev];
          for (const p of parts) if (!next.includes(p)) next.push(p);
          return next;
        });
        setNewTagDraft('');
      };
      const changeMember = (role, id) => {
        setPlan(current => {
          if (!current) return current;
          const members = { ...current.members };
          if (id) members[role] = id;
          else delete members[role];
          return { ...current, members };
        });
      };
      const changeCodeWork = enabled => {
        setExplicitCode(enabled);
        setPlan(current => {
          if (current) {
            return {
              ...current, codeWork: enabled,
              codex: enabled ? { coding: 'auto', review: 'auto' } : { coding: null, review: null },
            };
          }
          const tpl = choice === 'template' ? templateId : choice === 'none' ? 'none' : '';
          return tpl && leaderId ? buildLocalPlanFor(tpl, enabled, leaderId, workspace) : null;
        });
      };
      const create = async () => {
        if (!title.trim()) { setError('请填写标题'); return; }
        const useOrch = orchestrationMode !== 'plain' && leaderId !== '';
        if (leaderId && !workspace) { setError('请选择工单所属的工作区'); return; }
        if (requiresPr && !prUrl.trim()) { setError('请填写要审查的 PR 链接'); return; }
        if (useOrch && !plan) { await recommend(); return; }
        if (useOrch && roleChoices?.some(role => role.required && !plan.members[role.id])) {
          setError('请指派所有必需角色。');
          return;
        }
        const cleanedConfigs = cleanClientAgentConfigs(formAgentConfigs);
        const orchestration = useOrch ? {
          ...choiceBody(),
          plan: {
            templateId: plan.templateId,
            codeWork: plan.codeWork,
            members: plan.members,
            codex: plan.codex,
            ...(cleanedConfigs ? { agentConfigs: cleanedConfigs } : {}),
          },
        } : undefined;
        const pendingDraftTags = newTagDraft.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const assignedObj = assignedAgent ? catalog?.leaders.find(item => item.id === assignedAgent) : undefined;
        const agentTag = assignedObj ? ['智能体:' + assignedObj.name] : [];
        const mergedTagNames = [...new Set([...formTags, ...pendingDraftTags, ...agentTag])];
        const parsedTags = mergedTagNames.map(name => ({ name }));
        const effectiveWorkspace = useOrch ? workspace : (workspaceId || '');
        setBusy(true);
        setError('');
        setNotice('');
        try {
          let result;
          if (editing) {
            const orig = allTasks.find(item => item.id === editing);
            const cardPatch = {};
            if (!orig || title.trim() !== orig.title) cardPatch.title = title.trim();
            if (!orig || description.trim() !== (orig.description ?? '')) cardPatch.description = description.trim();
            if (orig && formPrompt.trim() !== (orig.prompt ?? '') && !(formPrompt.trim() === '' && orig.prompt === orig.description)) {
              cardPatch.prompt = formPrompt.trim() || description.trim() || title.trim();
            }
            const origAttSig = (orig?.attachments ?? []).map(a => a.attachmentId).join('|');
            const nextAttSig = formAttachments.map(a => a.attachmentId).join('|');
            if (origAttSig !== nextAttSig) {
              cardPatch.attachments = formAttachments.length > 0 ? formAttachments.map(serializeAttachmentForWire) : null;
            }
            if (formPermission && formPermission !== (orig?.permission ?? '')) cardPatch.permission = formPermission;
            if (formModel !== (orig?.model ?? '')) cardPatch.model = formModel;
            if (formEffort !== (orig?.reasoningEffort ?? '')) cardPatch.reasoningEffort = formEffort;
            if (formReuseSession !== (orig?.reuseSession === true)) cardPatch.reuseSession = formReuseSession;
            const origTagsSig = (orig?.tags ?? []).map(t => t.name).join('|');
            const nextTagsSig = parsedTags.map(t => t.name).join('|');
            if (origTagsSig !== nextTagsSig) cardPatch.tags = parsedTags.length > 0 ? parsedTags : null;
            if (effectiveWorkspace && !orig?.workflow && !orig?.taskRoom) cardPatch.workspaceId = effectiveWorkspace;

            if (Object.keys(cardPatch).length > 0) {
              result = await fetchJson('marshal/tasks/update', {
                taskId: editing,
                ...cardPatch,
              }, Boolean(orig?.workflow || orig?.taskRoom || effectiveWorkspace));
            }
            if (useOrch && orchestration) {
              result = await fetchJson('marshal/tasks/plan', { taskId: editing, orchestration }, true);
            }
            if (!result) result = { tasks: allTasks };
          } else {
            result = await fetchJson('marshal/tasks/create', {
              title: title.trim(),
              description: description.trim(),
              ...(formPrompt.trim() ? { prompt: formPrompt.trim() } : {}),
              ...(parsedTags.length > 0 ? { tags: parsedTags } : {}),
              ...(formAttachments.length > 0 ? { attachments: formAttachments.map(serializeAttachmentForWire) } : {}),
              ...(formParentId ? { parentId: formParentId } : {}),
              ...(formPermission ? { permission: formPermission } : {}),
              ...(formModel ? { model: formModel } : {}),
              ...(formEffort ? { reasoningEffort: formEffort } : {}),
              ...(formReuseSession ? { reuseSession: true } : {}),
              ...(effectiveWorkspace ? { workspaceId: effectiveWorkspace } : {}),
              ...(orchestration === undefined ? {} : { orchestration }),
            }, Boolean(effectiveWorkspace || orchestration));
          }
          setTasks(result.tasks || []);
          if (result.movedToReview) {
            setNotice('任务描述较模糊（' + (result.ambiguityReason || '信息尚不明确') + '），已自动转入「待确认」列等待确认。');
          } else if (editing) {
            setNotice(result.steered
              ? '工单修改已保存，并已将更新内容作为插话立即发送给正在运行的 Agent。'
              : (result.notice || result.configNotice || '工单与编排分工已保存，模型与思考强度变更将在下一轮对话生效。'));
          }
          setTitle('');
          setDescription('');
          setFormPrompt('');
          setFormTags([]);
          setNewTagDraft('');
          setFormParentId('');
          setFormPermission('');
          setFormModel('');
          setFormEffort('');
          setFormReuseSession(false);
          setFormAttachments([]);
          setAssignedAgent('');
          setOrchestrationMode('plain');
          setLeaderId('');
          setChoice('leader');
          setTemplateId('pr-review');
          setPrUrl('');
          setPlan(null);
          setFormAgentConfigs({});
          setExplicitCode(false);
          setEditing('');
          setFormOpen(false);
        }
        catch (e) { setError((editing ? '保存分工失败，' : '创建失败，') + (e.message || e)); }
        finally { setBusy(false); }
      };

      const saveWorkflowAgentConfigs = async (task, patch, labelHint = '智能体配置') => {
        if (busy || !task) return false;
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/agent-configs', { taskId: task.id, ...patch }, true);
          setTasks(result.tasks || []);
          setNotice(result.notice || ('已更新「' + labelHint + '」，工单群已发送变更提示，将在下一轮对话生效。'));
          return true;
        } catch (e) {
          setError('更新智能体配置失败：' + (e.message || e));
          return false;
        } finally {
          setBusy(false);
        }
      };

      const run = async (task) => {
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/run', { taskId: task.id }, Boolean(task.workflow || task.taskRoom));
          setTasks(result.tasks || []);
          if (result.permissionBlocked && result.message) setNotice(result.message);
        }
        catch (e) { setError('运行失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const move = async (task, status) => {
        if (busy || !task || task.status === status) return;
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/move', { taskId: task.id, status }, Boolean(task.workflow || task.taskRoom));
          setTasks(result.tasks || []);
        }
        catch (e) { setError('移动状态失败：' + (e.message || e)); }
        finally { setBusy(false); setDragTaskId(''); setDropCol(''); }
      };

      const confirmReview = async (task, applyPatch = false, noteText = '') => {
        if (busy || !task) return;
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const result = await fetchJson('marshal/tasks/confirm-review', {
            taskId: task.id,
            applyPatch,
            ...(noteText.trim() ? { note: noteText.trim() } : {}),
          }, Boolean(task.workflow || task.taskRoom));
          setTasks(result.tasks || []);
          setDrawerReviseNote('');
          setNotice(result.patchApplied
            ? '已将隔离开发补丁应用到工作区并确认工单完成。'
            : result.patchAlreadyApplied
              ? '补丁已在工作区生效，工单已确认完成。'
              : '工单已确认验收完成并归档。');
        }
        catch (e) { setError('确认完成失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const reviseTaskFromBoard = async (task, noteText = '') => {
        if (busy || !task) return;
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const result = await fetchJson('marshal/tasks/revise', {
            taskId: task.id,
            ...(noteText.trim() ? { text: noteText.trim() } : {}),
          }, Boolean(task.workflow || task.taskRoom || task.workspaceId));
          setTasks(result.tasks || []);
          setDrawerReviseNote('');
          setNotice('已将补充意见同步至工单群并启动继续执行。');
        }
        catch (e) { setError('继续执行失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const updateTask = async (task, patch) => {
        if (busy || !task) return false;
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/update', { taskId: task.id, ...patch }, Boolean(task.workflow || task.taskRoom));
          setTasks(result.tasks || []);
          if (result.steered && result.configNotice) {
            setNotice('内容已作为实时插话立刻发给运行中的 Agent；' + result.configNotice);
          } else if (result.steered) {
            setNotice('工单修改已保存，并已作为实时插话立即发送给正在运行的 Agent。');
          } else if (result.configNotice) {
            setNotice(result.configNotice);
          }
          return true;
        }
        catch (e) { setError('更新卡片失败：' + (e.message || e)); return false; }
        finally { setBusy(false); }
      };

      const setParent = async (task, parentId) => {
        if (busy || !task) return;
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/set-parent', { taskId: task.id, parentId: parentId || null }, Boolean(task.workflow || task.taskRoom));
          setTasks(result.tasks || []);
          setLinkChildId('');
        }
        catch (e) { setError('关联子任务失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const createSubtask = async (parentTask) => {
        const subTitle = newSubtaskTitle.trim();
        if (busy || !parentTask || !subTitle) return;
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/create', {
            title: subTitle, description: '', parentId: parentTask.id, skipAmbiguityCheck: true,
          }, false);
          setTasks(result.tasks || []);
          setNewSubtaskTitle('');
        }
        catch (e) { setError('创建子任务失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const duplicateTask = async (task) => {
        if (busy || !task) return;
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/create', {
            title: task.title + '（副本）',
            description: task.description ?? '',
            skipAmbiguityCheck: true,
            ...(task.prompt ? { prompt: task.prompt } : {}),
            ...(task.tags?.length ? { tags: task.tags } : {}),
            ...(task.permission ? { permission: task.permission } : {}),
            ...(task.model ? { model: task.model } : {}),
            ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}),
            ...(task.reuseSession ? { reuseSession: true } : {}),
            ...(task.attachments?.length ? { attachments: task.attachments.map(serializeAttachmentForWire) } : {}),
          }, false);
          setTasks(result.tasks || []);
        }
        catch (e) { setError('复制卡片失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const archiveTask = async (task) => {
        if (busy || !task) return;
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/archive', { taskId: task.id }, Boolean(task.workflow || task.taskRoom));
          setTasks(result.tasks || []);
          if (selectedId === task.id) setSelectedId('');
        }
        catch (e) { setError('归档失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const restoreTask = async (task) => {
        if (busy || !task) return;
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/restore', { taskId: task.id }, Boolean(task.workflow || task.taskRoom));
          setTasks(result.tasks || []);
        }
        catch (e) { setError('恢复失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const settleTask = async (task) => {
        if (busy || !task) return;
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/settle', { taskId: task.id }, Boolean(task.workflow || task.taskRoom));
          setTasks(result.tasks || []);
        }
        catch (e) { setError('终止失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const confirmPermission = async (task) => {
        if (busy || !task) return;
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/confirm-permission', { taskId: task.id }, Boolean(task.workflow || task.taskRoom));
          setTasks(result.tasks || []);
        }
        catch (e) { setError('确认权限失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const saveSchedule = async (task, enabled, mode, cron, onceIso) => {
        if (busy || !task) return;
        setBusy(true);
        setError('');
        try {
          const at = mode === 'once' && onceIso ? Math.floor(new Date(onceIso).getTime()) : undefined;
          const result = await fetchJson('marshal/tasks/schedule', {
            taskId: task.id, enabled, mode,
            ...(mode === 'cron' && cron.trim() ? { cron: cron.trim() } : {}),
            ...(mode === 'once' && Number.isFinite(at) ? { at } : {}),
          }, Boolean(task.workflow || task.taskRoom));
          setTasks(result.tasks || []);
        }
        catch (e) { setError('保存定时失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const remove = async (task) => {
        if (confirmId !== task.id) { setConfirmId(task.id); return; }
        setBusy(true);
        setError('');
        try {
          const result = await fetchJson('marshal/tasks/delete', { taskId: task.id }, Boolean(task.workflow || task.taskRoom));
          setTasks(result.tasks || []);
          setConfirmId('');
          if (selectedId === task.id) setSelectedId('');
        }
        catch (e) { setError('删除失败：' + (e.message || e)); }
        finally { setBusy(false); }
      };

      const iconRoom = () => h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }),
        h('circle', { cx: 9, cy: 7, r: 4 }),
        h('path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87' }),
        h('path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }));
      const iconSession = () => h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }));

      const renderAttachments = (items, onRemove, taskId = '') => {
        if (!Array.isArray(items) || items.length === 0) return null;
        return h('div', { className: 'mtb-att-list' },
          items.map(att => {
            const href = attachmentHref(taskId, att, previewUrlsRef.current);
            const fallbackImgSrc = resolveClientApiUrl('api/task-board/attachments/image?id=' + encodeURIComponent(att.attachmentId));
            const imgSrc = previewUrlsRef.current.get(att.attachmentId)
              || (taskId ? href : fallbackImgSrc);
            return h('div', { key: att.attachmentId, className: 'mtb-att-card', title: att.name + ' (' + formatBytes(att.bytes) + ')' },
              att.kind === 'image'
                ? h('img', {
                    className: 'mtb-att-thumb',
                    src: imgSrc,
                    alt: att.name,
                    onError: ev => {
                      if (ev.currentTarget.dataset.fallback !== '1' && ev.currentTarget.src !== fallbackImgSrc) {
                        ev.currentTarget.dataset.fallback = '1';
                        ev.currentTarget.src = fallbackImgSrc;
                      }
                    },
                  })
                : h('span', { style: { fontSize: 15, flexShrink: 0 }, 'aria-hidden': 'true' }, '📄'),
              h('div', { style: { minWidth: 0, flex: 1 } },
                href
                  ? h('a', {
                      className: 'mtb-att-link',
                      href,
                      target: '_blank',
                      rel: 'noreferrer',
                      download: att.kind === 'file' ? att.name : undefined,
                      onClick: ev => ev.stopPropagation(),
                    }, att.name)
                  : h('div', { style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, att.name),
                h('div', { style: { fontSize: 10.5, color: dswTheme.dim } },
                  formatBytes(att.bytes) + (att.kind === 'image' && att.width && att.height ? ' · ' + att.width + '×' + att.height : ''))),
              onRemove && h('button', { type: 'button', className: 'mtb-tag-x', 'aria-label': '移除附件 ' + att.name, onClick: () => onRemove(att.attachmentId) }, '×'));
          }));
      };

      const card = (task, column) => {
        const workflow = task.workflow;
        const step = workflow?.state === 'handed-off' ? '已交给 Leader'
          : workflow?.state === 'permission-blocked' ? '权限受阻 · 待确认'
          : workflow?.state === 'review-blocked' ? '审查待裁决 · 待确认'
          : workflow?.state === 'interrupted' ? '运行中断'
          : taskPhases[workflow?.phase];
        const isRunning = task.status === 'running' || task.openExecution === true || workflow?.state === 'running';
        const canMove = !busy && !isRunning;
        const parsedTitle = splitCardTitleKind(task.title);
        const timeAt = task.status === 'running' ? (task.startedAt ?? task.updatedAt ?? task.createdAt)
          : (task.status === 'done' || task.status === 'failed' || task.status === 'review') ? (task.endedAt ?? task.updatedAt ?? task.createdAt)
          : (task.createdAt ?? task.updatedAt);
        const timeLabel = formatTaskTime(timeAt);
        const timePrefix = task.status === 'backlog' || task.status === 'todo' ? '创建于 ' : '';
        const runs = Number(task.runCount || 0);
        const resultTone = isRunning ? 'running' : task.status === 'review' ? 'review' : task.result;
        const resultText = isRunning ? (step || '运行中…')
          : task.status === 'review' ? '待确认'
          : task.result ? (TASK_RESULT_LABELS[task.result] ?? task.result) : '';
        const subs = subtaskStats.get(task.id);
        const attCount = Array.isArray(task.attachments) ? task.attachments.length : 0;
        return h('article', {
          key: task.id,
          id: 'marshal-ticket-' + task.id,
          className: 'mtb-card',
          'data-status': task.status,
          'data-compact': compactCards ? 'true' : undefined,
          'data-focused': focusedTask === task.id ? 'true' : undefined,
          'data-selected': selectedId === task.id ? 'true' : undefined,
          'data-dragging': dragTaskId === task.id ? 'true' : undefined,
          draggable: canMove,
          onClick: () => { setSelectedId(task.id); setConfirmId(''); },
          onDragStart: event => {
            if (!canMove) { event.preventDefault(); return; }
            setDragTaskId(task.id);
            try { event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move'; } catch {}
          },
          onDragEnd: () => { setDragTaskId(''); setDropCol(''); },
          style: { '--mtb-accent': column.accent },
        },
          h('div', { className: 'mtb-card-title-row' },
            task.ticketNo && h('span', {
              className: 'mtb-card-kind',
              style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '.02em' },
              title: '工单号 ' + task.ticketNo,
            }, '[' + task.ticketNo + ']'),
            parsedTitle.kind && h('span', { className: 'mtb-card-kind' }, parsedTitle.kind),
            h('span', { className: 'mtb-card-title', title: (task.ticketNo ? '[' + task.ticketNo + '] ' : '') + task.title }, parsedTitle.text)),
          !compactCards && Array.isArray(task.tags) && task.tags.length > 0 && h('div', { className: 'mtb-card-tags' },
            task.tags.map(tag => h('span', {
              key: tag.name,
              className: 'mtb-tag',
              'data-tag-tone': taskTagTone(tag.name),
              title: tag.promptPrefix || tag.name,
            }, tag.name))),
          !compactCards && task.description && h('div', { className: 'mtb-card-excerpt' }, task.description),
          h('div', { className: 'mtb-card-meta' },
            task.parentId && h('span', { className: 'mtb-card-micro' }, '子任务'),
            subs && h('span', { className: 'mtb-card-micro' }, subs.done + '/' + subs.total + ' 子任务'),
            workflow?.leaderName && h('span', { className: 'mtb-card-micro', title: workflow.leaderName }, workflow.leaderName),
            attCount > 0 && h('span', { className: 'mtb-card-micro' }, '📎 ' + attCount),
            task.freeze && h('span', { className: 'mtb-card-micro', title: task.freeze.goal || '已冻结' }, '已冻结'),
            task.schedule?.enabled && h('span', { className: 'mtb-card-micro' }, task.schedule.mode === 'once' ? '定时一次' : '定时'),
            timeLabel && h('span', { className: 'mtb-card-time' }, timePrefix + timeLabel)),
          !compactCards && h('div', { className: 'mtb-card-foot' },
            h('div', { className: 'mtb-card-foot-left' },
              resultText && h('span', { className: 'mtb-result', 'data-tone': resultTone }, resultText),
              runs > 0 && h('span', { className: 'mtb-runs' }, runs + ' 次运行'),
              !resultText && step && h('span', { className: 'mtb-runs' }, step)),
            h('div', { className: 'mtb-card-foot-right' },
              isRunning && h('span', { className: 'mtb-spinner', 'aria-hidden': 'true' }),
              task.status === 'review' && canMove && h('button', {
                type: 'button',
                className: 'mtb-icon-pill',
                disabled: busy,
                title: '退回待办重新修改或重跑',
                onClick: event => { event.stopPropagation(); void move(task, 'todo'); },
              }, '↩ 待办'),
              task.status === 'review' && canMove && h('button', {
                type: 'button',
                className: 'mtb-icon-pill mtb-icon-pill-confirm',
                disabled: busy,
                title: task.patchAvailable ? '打开确认面板选择是否将补丁应用到工作区' : '确认验收完成并移入已完成',
                onClick: event => {
                  event.stopPropagation();
                  if (task.patchAvailable) {
                    setSelectedId(task.id);
                    setNotice('此工单包含隔离开发补丁，请在右侧详情面板选择「应用补丁并完成」或「仅确认完成」。');
                  } else {
                    void confirmReview(task, false);
                  }
                },
              }, '✓ 确认'),
              h('button', {
                type: 'button',
                className: 'mtb-icon-pill',
                title: '进入工单群',
                onClick: event => { event.stopPropagation(); openTaskRoom?.(task); },
              }, iconRoom(), '工单群'),
              task.sessionId && h('button', {
                type: 'button',
                className: 'mtb-icon-btn',
                title: '打开会话',
                'aria-label': '打开会话',
                onClick: event => { event.stopPropagation(); openSession && openSession(task.sessionId); },
              }, iconSession()))));
      };

      const selectedColumn = selectedTask ? (columns.find(c => c.key === selectedTask.status) ?? columns[1]) : undefined;

      const renderParseModal = () => {
        if (!parseOpen) return null;
        return h('div', {
          className: 'mtb-modal-backdrop',
          onClick: e => { if (e.target === e.currentTarget && !parseBusy) setParseOpen(false); },
        },
          h('div', { className: 'mtb-modal', role: 'dialog', 'aria-label': 'AI 自动解析任务' },
            h('div', { className: 'mtb-drawer-head', style: { '--mtb-accent': '#8b5cf6' } },
              h('span', { className: 'mtb-dot' }),
              h('strong', { style: { fontSize: 14, flex: 1 } }, '✨ AI 自动解析任务'),
              h('button', { type: 'button', className: 'mtb-icon-btn', disabled: parseBusy, onClick: () => setParseOpen(false) }, '✕')),
            h('div', { style: { padding: 18, display: 'grid', gap: 12, overflowY: 'auto' } },
              h('div', { style: { fontSize: 12, color: dswTheme.dim, lineHeight: 1.55 } },
                '粘贴聊天记录、Issue 原文、零散想法或需求段落，AI 将自动提炼出结构化的标题、描述与执行指令并填入新建卡片表单。'),
              h(Field, { label: '解析模型' },
                h('select', { style: uiInput, value: parseModel, disabled: parseBusy, onChange: e => setParseModel(e.target.value) },
                  modelOptions.length === 0
                    ? h('option', { value: '' }, '未读取到模型目录')
                    : modelOptions.map(opt => h('option', { key: opt.route, value: opt.route }, opt.label)))),
              h(Field, { label: '原始任务文本' },
                h('textarea', {
                  style: { ...uiInput, resize: 'vertical', lineHeight: 1.6 },
                  rows: 7,
                  value: parseInput,
                  disabled: parseBusy,
                  placeholder: '例如：帮我把登录接口的 403 问题查清楚并修复，加回归测试并验证重启后生效…',
                  onChange: e => setParseInput(e.target.value),
                })),
              parseError && h('div', { role: 'alert', style: { color: dswTheme.danger, fontSize: 12 } }, parseError)),
            h('div', { className: 'mtb-drawer-foot', style: { justifyContent: 'flex-end' } },
              h('button', { type: 'button', className: 'mtb-btn', disabled: parseBusy, onClick: () => setParseOpen(false) }, '取消'),
              h('button', { type: 'button', className: 'mtb-btn mtb-btn-ai', disabled: parseBusy || !parseInput.trim(), onClick: () => { void runAiParse(); } },
                parseBusy ? '解析中…' : '✨ 解析并填入表单'))));
      };

      const renderDrawer = () => {
        if (!selectedTask || !selectedColumn) return null;
        const task = selectedTask;
        const archived = task.archivedAt !== undefined;
        const workflow = task.workflow;
        const execution = workflow?.selected ?? workflow?.templateId;
        const templateName = catalog?.templates.find(item => item.id === execution)?.name;
        const modeLabel = execution === 'none' || workflow?.choice === 'none' ? '普通任务'
          : templateName ?? (workflow?.choice === 'leader' ? '由 Leader 决定' : '编排任务');
        const step = workflow?.state === 'handed-off' ? '已交给 Leader'
          : workflow?.state === 'permission-blocked' ? '权限受阻 · 待确认'
          : workflow?.state === 'review-blocked' ? '审查待裁决 · 待确认'
          : workflow?.state === 'interrupted' ? '运行中断，可重试'
          : taskPhases[workflow?.phase];
        const isRunning = task.status === 'running' || task.openExecution === true || workflow?.state === 'running';
        const canMove = !busy && !archived && !isRunning;
        const permLabel = task.permission ? (TASK_PERMISSION_LABELS[task.permission] ?? task.permission) : '';
        const needsPermConfirm = Boolean(!archived && task.permission && (PERMISSION_RANK[task.permission] ?? 0) > (PERMISSION_RANK[sessionDefaultPerm] ?? 0) && !task.permissionConfirmedAt);
        const currentTagNames = (task.tags ?? []).map(t => t.name);
        const currentAgentTag = currentTagNames.find(n => n.startsWith('智能体:'));
        const parentCard = task.parentId ? allTasks.find(t => t.id === task.parentId) : undefined;
        const childCards = allActive.filter(t => t.parentId === task.id);
        const linkableChildren = allActive.filter(t => t.id !== task.id && t.parentId === undefined && t.id !== task.parentId && !allActive.some(c => c.parentId === t.id));
        const suggestedDrawerTags = [...new Set([...PRIORITY_TAGS, ...knownTags.map(t => t.name)])].filter(name => !currentTagNames.includes(name));
        const drawerAttachments = Array.isArray(task.attachments) ? task.attachments : [];
        const drawerExecutions = Array.isArray(task.executions) ? [...task.executions].reverse() : [];
        const drawerAmbiguity = !archived && task.status === 'review' && drawerExecutions.length === 0
          ? clientAmbiguityHint(task.title, task.description, task.prompt, drawerAttachments.length > 0, Boolean(workflow?.pr))
          : '';
        const toggleDrawerTag = async name => {
          const nextNames = currentTagNames.includes(name) ? currentTagNames.filter(n => n !== name) : [...currentTagNames, name];
          await updateTask(task, { tags: nextNames.length > 0 ? nextNames.map(n => ({ name: n })) : null });
        };
        const assignDrawerAgentLeader = async agentName => {
          const cleaned = currentTagNames.filter(n => !n.startsWith('智能体:'));
          const nextNames = agentName ? [...cleaned, '智能体:' + agentName] : cleaned;
          await updateTask(task, { tags: nextNames.length > 0 ? nextNames.map(n => ({ name: n })) : null });
        };
        const addDrawerTag = async () => {
          const parts = drawerTagDraft.split(/[,，]/).map(s => s.trim()).filter(Boolean);
          if (parts.length === 0) return;
          const nextNames = [...new Set([...currentTagNames, ...parts])];
          const ok = await updateTask(task, { tags: nextNames.map(n => ({ name: n })) });
          if (ok) setDrawerTagDraft('');
        };
        const openDrawerEditor = () => {
          if (!drawerEditing) {
            setEditTitle(task.title || '');
            setEditDesc(task.description || '');
            setEditPrompt(task.prompt || '');
            setEditPerm(task.permission || '');
            setEditModel(task.model || '');
            setEditEffort(task.reasoningEffort || '');
            setEditReuseSession(task.reuseSession === true);
            setEditFreezeGoal(task.freeze?.goal || '');
            setEditSteerNow(true);
          }
          setDrawerEditing(v => !v);
        };
        const saveDrawerEdit = async () => {
          const patch = {};
          const trimmedTitle = editTitle.trim();
          if (!trimmedTitle) return;
          if (trimmedTitle !== (task.title || '')) patch.title = trimmedTitle;
          if (editDesc !== (task.description || '')) patch.description = editDesc;
          if (editPrompt !== (task.prompt || '')) patch.prompt = editPrompt;
          if (editPerm && editPerm !== (task.permission || '')) patch.permission = editPerm;
          if (editModel !== (task.model || '')) patch.model = editModel;
          if (editEffort !== (task.reasoningEffort || '')) patch.reasoningEffort = editEffort;
          if (editReuseSession !== (task.reuseSession === true)) patch.reuseSession = editReuseSession;
          const prevGoal = task.freeze?.goal || '';
          const nextGoal = editFreezeGoal.trim();
          if (nextGoal !== prevGoal) patch.freeze = nextGoal ? { goal: nextGoal } : null;
          if (Object.keys(patch).length === 0) {
            setDrawerEditing(false);
            return;
          }
          if ('title' in patch || 'description' in patch || 'prompt' in patch) {
            patch.steerNow = isRunning ? editSteerNow : false;
          }
          const ok = await updateTask(task, patch);
          if (ok) setDrawerEditing(false);
        };

        return h('div', {
          className: 'mtb-backdrop',
          onClick: event => { if (event.target === event.currentTarget) { setSelectedId(''); setConfirmId(''); setDrawerEditing(false); } },
        },
          h('aside', { className: 'mtb-drawer', 'aria-label': '卡片详情', style: { '--mtb-accent': selectedColumn.accent } },
            h('div', { className: 'mtb-drawer-head' },
              h('span', { className: 'mtb-dot', 'data-pulse': selectedColumn.pulse && !archived ? 'true' : undefined }),
              task.ticketNo && h('span', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 6, border: '1px solid ' + dswTheme.border2, background: dswTheme.layer } }, '[' + task.ticketNo + ']'),
              h('strong', { style: { fontSize: 13, flex: 1 } }, archived ? '已归档 · ' + selectedColumn.label : selectedColumn.label),
              canMove && h('select', {
                'aria-label': '切换状态',
                className: 'mtb-move',
                value: knownStatuses.has(task.status) ? task.status : 'todo',
                disabled: busy,
                onChange: event => { void move(task, event.target.value); },
              }, columns.map(col => h('option', { key: col.key, value: col.key }, col.label))),
              !archived && h('button', { type: 'button', className: 'mtb-btn', onClick: openDrawerEditor }, drawerEditing ? '取消编辑' : (isRunning ? '实时编辑' : '编辑')),
              h('button', { type: 'button', className: 'mtb-icon-btn', 'aria-label': '关闭详情', onClick: () => { setSelectedId(''); setConfirmId(''); setDrawerEditing(false); } }, '✕')),
            h('div', { className: 'mtb-drawer-body' },
              error && h('div', { role: 'alert', style: { padding: '8px 12px', borderRadius: 9, fontSize: 12, color: dswTheme.danger, background: 'color-mix(in srgb, #ef4444 10%, transparent)', border: '1px solid color-mix(in srgb, #ef4444 30%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                h('span', null, error),
                h('button', { type: 'button', className: 'mtb-icon-btn', onClick: () => setError('') }, '✕')),
              notice && h('div', { role: 'status', style: { padding: '8px 12px', borderRadius: 9, fontSize: 12, color: '#10b981', background: 'color-mix(in srgb, #10b981 10%, transparent)', border: '1px solid color-mix(in srgb, #10b981 30%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                h('span', null, notice),
                h('button', { type: 'button', className: 'mtb-icon-btn', onClick: () => setNotice('') }, '✕')),
              !archived && task.status === 'review' && (() => {
                const reviewMeta = describeReviewState(task, workflow, drawerAmbiguity, needsPermConfirm);
                return h('div', { className: 'mtb-review-panel' },
                  h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
                    h('strong', { style: { fontSize: 12.5, color: '#a78bfa' } }, reviewMeta.badge),
                    task.patchAvailable && h('span', { style: { fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'color-mix(in srgb, #06b6d4 16%, transparent)', color: '#06b6d4' } }, '含待落盘代码补丁')),
                  h('div', { style: { fontSize: 12, color: dswTheme.dim } }, h(RichMarkdown, { text: reviewMeta.summary })),
                  h('textarea', {
                    value: drawerReviseNote,
                    onChange: e => setDrawerReviseNote(e.target.value),
                    rows: 2,
                    placeholder: '可选：填写裁决结论、调整方向或验收备注（点「继续修正」会写入工单群并驱动智能体按此意见执行）…',
                    style: { ...uiInput, resize: 'vertical', lineHeight: 1.5 },
                  }),
                  h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
                    task.patchAvailable && h('button', {
                      type: 'button', className: 'mtb-btn mtb-btn-confirm', disabled: busy,
                      onClick: () => { void confirmReview(task, true, drawerReviseNote); },
                    }, '✓ 应用补丁到工作区并完成'),
                    h('button', {
                      type: 'button', className: task.patchAvailable ? 'mtb-btn' : 'mtb-btn mtb-btn-confirm', disabled: busy,
                      onClick: () => { void confirmReview(task, false, drawerReviseNote); },
                    }, task.patchAvailable ? '仅确认完成（不写工作区）' : '✓ 确认验收完成'),
                    h('button', {
                      type: 'button', className: 'mtb-btn mtb-btn-accent', disabled: busy,
                      onClick: () => { void reviseTaskFromBoard(task, drawerReviseNote); },
                    }, '↻ 按意见继续执行'),
                    h('button', {
                      type: 'button', className: 'mtb-btn',
                      onClick: () => { setSelectedId(''); openTaskRoom?.(task); },
                    }, '去工单群讨论')));
              })(),
              drawerAmbiguity && task.status !== 'review' && h('div', { className: 'mtb-warn-hint' },
                '⚠ ' + drawerAmbiguity + ' 点右上角「编辑」补充后可点击下方「移回待办」继续执行。'),
              needsPermConfirm && h('div', { className: 'mtb-warn-hint', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } },
                h('span', null, '此卡片权限（' + permLabel + '）高于默认基线，运行前需人工确认。'),
                h('button', { type: 'button', className: 'mtb-btn mtb-btn-confirm', disabled: busy, onClick: () => { void confirmPermission(task); } }, '确认高权限')),

              drawerEditing
                ? h('div', { className: 'mtb-drawer-sec' },
                    h(Field, { label: '标题' }, h('input', { style: uiInput, value: editTitle, onChange: e => setEditTitle(e.target.value) })),
                    h(Field, { label: '描述' }, h('textarea', { style: { ...uiInput, resize: 'vertical', lineHeight: 1.55 }, rows: 4, value: editDesc, onChange: e => setEditDesc(e.target.value) })),
                    h(Field, { label: '执行指令 Prompt' }, h('textarea', { style: { ...uiInput, resize: 'vertical', lineHeight: 1.55 }, rows: 3, value: editPrompt, onChange: e => setEditPrompt(e.target.value) })),
                    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
                      h(Field, { label: '模型' }, h('select', { style: uiInput, value: editModel, onChange: e => setEditModel(e.target.value) },
                        modelSelectOptions('', editModel).map(opt => h('option', { key: opt.route || '__default', value: opt.route }, opt.label)))),
                      h(Field, { label: '思考模式' }, h('select', { style: uiInput, value: editEffort, onChange: e => setEditEffort(e.target.value) },
                        thinkingModeOptions(editModel, '', editEffort).map(opt => h('option', { key: opt.id || '__default', value: opt.id }, opt.label))))),
                    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
                      h(Field, { label: '权限预设' }, h('select', { style: uiInput, value: editPerm, onChange: e => setEditPerm(e.target.value) },
                        h('option', { value: '' }, '跟随默认'),
                        h('option', { value: 'read-only' }, '只读'),
                        h('option', { value: 'workspace-write' }, '工作区可写'),
                        h('option', { value: 'danger-full-access' }, '完全权限'))),
                      h(Field, { label: '冻结目标（可选，清空解冻）' }, h('input', { style: uiInput, value: editFreezeGoal, placeholder: '例如：等 PR #6 合并后推进', onChange: e => setEditFreezeGoal(e.target.value) }))),
                    h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                      h('input', { type: 'checkbox', checked: editReuseSession, onChange: e => setEditReuseSession(e.target.checked) }),
                      '复用上次执行会话（保留上下文）'),
                    isRunning && h('label', {
                      style: {
                        display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12, lineHeight: 1.5,
                        padding: '8px 10px', borderRadius: 8,
                        background: 'color-mix(in srgb, #3b82f6 10%, transparent)',
                        border: '1px solid color-mix(in srgb, #3b82f6 28%, transparent)',
                      },
                    },
                      h('input', { type: 'checkbox', style: { marginTop: 2 }, checked: editSteerNow, onChange: e => setEditSteerNow(e.target.checked) }),
                      h('span', null, '立即以插话形式将修改后的内容发送给正在运行的 Agent（模型与思考强度变更自动在下一轮对话生效并通知工单群）')),
                    h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6 } },
                      h('button', { type: 'button', className: 'mtb-btn', onClick: () => setDrawerEditing(false) }, '取消'),
                      h('button', { type: 'button', className: 'mtb-btn mtb-btn-accent', disabled: busy || !editTitle.trim(), onClick: () => { void saveDrawerEdit(); } }, isRunning && editSteerNow ? '保存并立即插话发送' : '保存修改')))
                : h(React.Fragment, null,
                    h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.45, wordBreak: 'break-word' } }, task.title),
                    h('div', { className: 'mtb-card-meta' },
                      task.createdAt && h('span', null, '创建于 ' + new Date(task.createdAt).toLocaleString()),
                      Number(task.runCount || 0) > 0 && h('span', null, '· ' + task.runCount + ' 次运行'),
                      permLabel && h('span', { className: 'mtb-card-micro' }, permLabel),
                      task.model && h('span', { className: 'mtb-card-micro' }, task.model),
                      task.reasoningEffort && h('span', { className: 'mtb-card-micro' }, '思考: ' + task.reasoningEffort),
                      task.reuseSession && h('span', { className: 'mtb-card-micro' }, '复用会话'),
                      task.freeze && h('span', { className: 'mtb-card-micro' }, '已冻结' + (task.freeze.goal ? ': ' + task.freeze.goal : ''))),
                    task.description
                      ? h('div', { style: { fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '10px 12px', borderRadius: 10, background: 'color-mix(in srgb, currentColor 4%, transparent)', border: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 10%, transparent))' } }, task.description)
                      : h('div', { style: uiMuted }, '暂无描述'),
                    task.prompt && task.prompt !== task.description && task.prompt !== task.title && h('details', { className: 'mtb-drawer-sec' },
                      h('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600, color: dswTheme.dim } }, '执行指令 Prompt'),
                      h('pre', { style: { margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.55, fontFamily: 'inherit' } }, task.prompt))),

              !archived && (() => {
                if (workflow) {
                  const wfConfigs = { ...(workflow.agentConfigs ?? {}), ...(workflow.plan?.agentConfigs ?? {}) };
                  const wfPool = (catalog?.leaders ?? []).filter(item => item.global || item.workspaceId === workflow.workspaceId);
                  const leaderMeta = wfPool.find(item => item.id === workflow.leaderId) ?? (catalog?.leaders ?? []).find(item => item.id === workflow.leaderId);
                  const leaderCfg = wfConfigs.leader ?? {};
                  const activeTplId = workflow.plan?.templateId ?? workflow.selected ?? workflow.templateId ?? (workflow.choice === 'none' ? 'none' : '');
                  const activeTplMeta = activeTplId === 'none' ? catalog?.plainTemplate : catalog?.templates?.find(t => t.id === activeTplId);
                  const wfCodeWork = Boolean(workflow.plan?.codeWork || activeTplId === 'development');
                  const wfSlots = workflow.plan ? ((wfCodeWork ? activeTplMeta?.codingRoles : activeTplMeta?.roles) ?? Object.keys(workflow.plan.members ?? {}).map(id => ({ id, name: id }))) : [];
                  const codexSlots = workflow.plan ? (wfCodeWork ? ['coding', 'review'] : (activeTplId === 'pr-review' ? ['review'] : [])) : [];
                  const controlsDisabled = busy;
                  return h('div', { className: 'mtb-drawer-sec', 'aria-label': '参战 Agent 模型与思考模式' },
                    h('div', { className: 'mtb-drawer-sec-title' },
                      '🤖 参战 Agent 模型与思考模式',
                      h('span', { style: { fontSize: 10.5, fontWeight: 500, color: isRunning ? '#3b82f6' : dswTheme.faint } },
                        isRunning ? '● 运行中可随时切换 · 下一轮生效并通知工单群' : '切换后通知工单群 · 下一轮生效')),
                    h('div', { className: 'mtb-agent-cfg-list' },
                      // 1) Leader Row
                      h('div', { className: 'mtb-agent-cfg-row' },
                        h('div', { className: 'mtb-agent-cfg-head' },
                          h('span', null, '👑 Leader · ' + (leaderMeta?.name || workflow.leaderName || '未绑定')),
                          h('span', { style: { fontSize: 10.5, fontWeight: 500, color: dswTheme.faint } }, modeLabel)),
                        h('div', { className: 'mtb-agent-cfg-grid' },
                          wfPool.length > 0 && h('select', {
                            'aria-label': 'Leader 人选',
                            style: uiInput,
                            disabled: controlsDisabled,
                            value: workflow.leaderId || '',
                            onChange: e => {
                              const picked = wfPool.find(item => item.id === e.target.value);
                              if (picked) void saveWorkflowAgentConfigs(task, { leaderId: picked.id }, 'Leader → ' + picked.name);
                            },
                          }, wfPool.map(item => h('option', { key: item.id, value: item.id }, 'Leader: ' + item.name))),
                          h('select', {
                            'aria-label': 'Leader 模型',
                            style: uiInput,
                            disabled: controlsDisabled,
                            value: leaderCfg.model || '',
                            onChange: e => { void saveWorkflowAgentConfigs(task, { agentConfigs: { leader: { ...leaderCfg, model: e.target.value } } }, (leaderMeta?.name || 'Leader') + ' 模型'); },
                          }, modelSelectOptions(leaderMeta?.model || '', leaderCfg.model || '').map(opt => h('option', { key: opt.route || '__def', value: opt.route }, opt.label))),
                          h('select', {
                            'aria-label': 'Leader 思考模式',
                            style: uiInput,
                            disabled: controlsDisabled,
                            value: leaderCfg.reasoningEffort || '',
                            onChange: e => { void saveWorkflowAgentConfigs(task, { agentConfigs: { leader: { ...leaderCfg, reasoningEffort: e.target.value } } }, (leaderMeta?.name || 'Leader') + ' 思考模式'); },
                          }, thinkingModeOptions(leaderCfg.model || leaderMeta?.model || '', leaderMeta?.reasoningEffort || '', leaderCfg.reasoningEffort || '').map(opt => h('option', { key: opt.id || '__def', value: opt.id }, opt.label))))),
                      // 2) Role Slot Rows
                      wfSlots.filter(slot => slot.id !== 'codexCritic').map(slot => {
                        const memberIdVal = workflow.plan?.members?.[slot.id] ?? '';
                        const memberMeta = wfPool.find(m => m.id === memberIdVal);
                        const slotCfg = wfConfigs[slot.id] ?? {};
                        const rolePool = wfPool.filter(m => m.id !== workflow.leaderId && (slot.id !== 'coder' || ['workspace-write', 'danger-full-access'].includes(m.permission)));
                        return h('div', { key: slot.id, className: 'mtb-agent-cfg-row' },
                          h('div', { className: 'mtb-agent-cfg-head' },
                            h('span', null, '🧩 ' + slot.name + ' · ' + (memberIdVal === '@dsh' ? '独立 DSH 席位' : (memberMeta?.name || '待指派')))),
                          h('div', { className: 'mtb-agent-cfg-grid' },
                            h('select', {
                              'aria-label': slot.name + ' 人选',
                              style: uiInput,
                              disabled: controlsDisabled,
                              value: memberIdVal,
                              onChange: e => { void saveWorkflowAgentConfigs(task, { members: { [slot.id]: e.target.value } }, slot.name + ' 指派'); },
                            },
                              !slot.required && h('option', { value: '' }, '暂不指派'),
                              slot.id === 'critic' && h('option', { value: '@dsh' }, '独立 DSH 审查席位'),
                              rolePool.map(m => h('option', {
                                key: m.id, value: m.id,
                                disabled: Object.entries(workflow.plan?.members ?? {}).some(([k, v]) => k !== slot.id && v === m.id),
                              }, slot.name + ': ' + m.name))),
                            h('select', {
                              'aria-label': slot.name + ' 模型',
                              style: uiInput,
                              disabled: controlsDisabled || !memberIdVal,
                              value: slotCfg.model || '',
                              onChange: e => { void saveWorkflowAgentConfigs(task, { agentConfigs: { [slot.id]: { ...slotCfg, model: e.target.value } } }, (memberMeta?.name || slot.name) + ' 模型'); },
                            }, modelSelectOptions(memberMeta?.model || '', slotCfg.model || '').map(opt => h('option', { key: opt.route || '__def', value: opt.route }, opt.label))),
                            h('select', {
                              'aria-label': slot.name + ' 思考模式',
                              style: uiInput,
                              disabled: controlsDisabled || !memberIdVal,
                              value: slotCfg.reasoningEffort || '',
                              onChange: e => { void saveWorkflowAgentConfigs(task, { agentConfigs: { [slot.id]: { ...slotCfg, reasoningEffort: e.target.value } } }, (memberMeta?.name || slot.name) + ' 思考模式'); },
                            }, thinkingModeOptions(slotCfg.model || memberMeta?.model || '', memberMeta?.reasoningEffort || '', slotCfg.reasoningEffort || '').map(opt => h('option', { key: opt.id || '__def', value: opt.id }, opt.label)))));
                      }),
                      // 3) Codex Sub-Agent Rows
                      codexSlots.map(slot => {
                        const cfgKey = slot === 'coding' ? 'codexCoding' : 'codexReview';
                        const slotTitle = slot === 'coding' ? '⚙️ Codex · 编码执行子 Agent' : '🔍 Codex · 审查复核子 Agent';
                        const codexVal = workflow.plan?.codex?.[slot] === null ? 'off' : (workflow.plan?.codex?.[slot] || 'auto');
                        const slotCfg = wfConfigs[cfgKey] ?? {};
                        return h('div', { key: cfgKey, className: 'mtb-agent-cfg-row' },
                          h('div', { className: 'mtb-agent-cfg-head' }, h('span', null, slotTitle)),
                          h('div', { className: 'mtb-agent-cfg-grid' },
                            h('select', {
                              'aria-label': slotTitle + ' 模型',
                              style: uiInput,
                              disabled: controlsDisabled,
                              value: codexVal,
                              onChange: e => {
                                const nextVal = e.target.value === 'off' ? null : e.target.value;
                                void saveWorkflowAgentConfigs(task, {
                                  codex: { [slot]: nextVal },
                                  agentConfigs: { [cfgKey]: { ...slotCfg, model: nextVal && nextVal !== 'auto' ? nextVal : '' } },
                                }, slotTitle + ' 模型');
                              },
                            },
                              h('option', { value: 'auto' }, '模型：自动选择 Codex'),
                              h('option', { value: 'off' }, '关闭此阶段 Codex 子调用'),
                              codexVal !== 'auto' && codexVal !== 'off' && !codexModels.some(m => m.id === codexVal) && h('option', { value: codexVal }, codexVal),
                              codexModels.filter(m => slot !== 'coding' || m.work).map(m => h('option', { key: m.id, value: m.id }, 'Codex: ' + m.model))),
                            h('select', {
                              'aria-label': slotTitle + ' 思考模式',
                              style: uiInput,
                              disabled: controlsDisabled || codexVal === 'off',
                              value: slotCfg.reasoningEffort || '',
                              onChange: e => { void saveWorkflowAgentConfigs(task, { agentConfigs: { [cfgKey]: { ...slotCfg, reasoningEffort: e.target.value } } }, slotTitle + ' 思考模式'); },
                            }, codexThinkingOptions(codexVal, slotCfg.reasoningEffort || '').map(opt => h('option', { key: opt.id || '__def', value: opt.id }, opt.label)))));
                      })));
                }
                // Plain / Single-Agent Card quick switcher
                const boundAgentName = currentAgentTag ? currentAgentTag.slice(4) : '';
                const boundAgentMeta = (catalog?.leaders ?? []).find(item => item.name === boundAgentName);
                return h('div', { className: 'mtb-drawer-sec', 'aria-label': '执行智能体模型与思考模式' },
                  h('div', { className: 'mtb-drawer-sec-title' },
                    '🤖 执行 Agent 模型与思考模式',
                    h('span', { style: { fontSize: 10.5, fontWeight: 500, color: isRunning ? '#3b82f6' : dswTheme.faint } },
                      isRunning ? '● 运行中可改 · 下一轮生效并通知工单群' : '切换后下一轮生效')),
                  h('div', { className: 'mtb-agent-cfg-row' },
                    h('div', { className: 'mtb-agent-cfg-grid' },
                      (catalog?.leaders?.length ?? 0) > 0 && h('select', {
                        'aria-label': '指派智能体',
                        style: uiInput,
                        disabled: busy,
                        value: boundAgentName,
                        onChange: e => { void assignDrawerAgentLeader(e.target.value); },
                      },
                        h('option', { value: '' }, '指派 Agent：未指派'),
                        catalog.leaders.map(item => h('option', { key: item.id, value: item.name }, 'Agent: ' + item.name))),
                      h('select', {
                        'aria-label': '工单模型',
                        style: uiInput,
                        disabled: busy,
                        value: task.model || '',
                        onChange: e => {
                          const v = e.target.value;
                          setEditModel(v);
                          void updateTask(task, { model: v });
                        },
                      }, modelSelectOptions(boundAgentMeta?.model || '', task.model || '').map(opt => h('option', { key: opt.route || '__def', value: opt.route }, opt.label))),
                      h('select', {
                        'aria-label': '工单思考模式',
                        style: uiInput,
                        disabled: busy,
                        value: task.reasoningEffort || '',
                        onChange: e => {
                          const v = e.target.value;
                          setEditEffort(v);
                          void updateTask(task, { reasoningEffort: v });
                        },
                      }, thinkingModeOptions(task.model || boundAgentMeta?.model || '', boundAgentMeta?.reasoningEffort || '', task.reasoningEffort || '').map(opt => h('option', { key: opt.id || '__def', value: opt.id }, opt.label))))));
              })(),

              h('div', { className: 'mtb-drawer-sec' },
                h('div', { className: 'mtb-drawer-sec-title' }, '标签与优先级'),
                h('div', { className: 'mtb-card-tags' },
                  currentTagNames.length === 0
                    ? h('span', { style: uiMuted }, '暂无标签')
                    : currentTagNames.map(name => h('span', { key: name, className: 'mtb-tag', 'data-tag-tone': taskTagTone(name) },
                        name,
                        !archived && h('button', { type: 'button', className: 'mtb-tag-x', 'aria-label': '移除 ' + name, disabled: busy, onClick: () => { void toggleDrawerTag(name); } }, '×')))),
                !archived && h('div', { style: { display: 'flex', gap: 6 } },
                  h('input', {
                    style: { ...uiInput, padding: '5px 9px' },
                    value: drawerTagDraft,
                    placeholder: '输入新标签，如 记忆 / P1…',
                    onChange: e => setDrawerTagDraft(e.target.value),
                    onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); void addDrawerTag(); } },
                  }),
                  h('button', { type: 'button', className: 'mtb-btn', disabled: busy || !drawerTagDraft.trim(), onClick: () => { void addDrawerTag(); } }, '＋ 添加')),
                !archived && suggestedDrawerTags.length > 0 && h('div', { className: 'mtb-card-tags' },
                  suggestedDrawerTags.map(name => h('button', {
                    key: name, type: 'button', className: 'mtb-tag mtb-tag-btn',
                    'data-tag-tone': taskTagTone(name), disabled: busy,
                    onClick: () => { void toggleDrawerTag(name); },
                  }, '＋ ' + name)))),

              h('div', { className: 'mtb-drawer-sec' },
                h('div', { className: 'mtb-drawer-sec-title' },
                  '附件（图片 / 文件，最多 8 个）',
                  !archived && drawerAttachments.length < 8 && h('label', { className: 'mtb-btn', style: { cursor: uploading ? 'wait' : 'pointer', padding: '3px 9px', fontSize: 11 } },
                    uploading ? '上传中…' : '📎 上传附件',
                    h('input', {
                      type: 'file', multiple: true, style: { display: 'none' }, disabled: uploading || busy,
                      onChange: e => {
                        const picked = Array.from(e.target.files || []);
                        e.target.value = '';
                        void uploadFiles(picked, added => {
                          const existingIds = new Set(drawerAttachments.map(a => a.attachmentId));
                          const merged = [
                            ...drawerAttachments.map(serializeAttachmentForWire),
                            ...added.filter(a => !existingIds.has(a.attachmentId)),
                          ].slice(0, 8);
                          void updateTask(task, { attachments: merged, ...(isRunning ? { steerNow: true } : {}) });
                        });
                      },
                    }))),
                drawerAttachments.length === 0
                  ? h('span', { style: uiMuted }, '暂无附件')
                  : renderAttachments(drawerAttachments, archived ? undefined : attId => {
                      const remaining = drawerAttachments.filter(a => a.attachmentId !== attId).map(serializeAttachmentForWire);
                      void updateTask(task, { attachments: remaining.length > 0 ? remaining : null, ...(isRunning ? { steerNow: true } : {}) });
                    }, task.id)),

              h('div', { className: 'mtb-drawer-sec' },
                h('div', { className: 'mtb-drawer-sec-title' },
                  '父任务 / 子任务关联',
                  childCards.length > 0 && h('span', { style: { fontWeight: 500, fontSize: 11 } }, childCards.length + ' 个子任务')),
                parentCard && h('div', { className: 'mtb-sub-row' },
                  h('span', { style: { fontSize: 11, color: dswTheme.faint } }, '父任务'),
                  h('button', { type: 'button', style: { border: 0, background: 'transparent', color: 'inherit', fontWeight: 600, fontSize: 12, cursor: 'pointer', textAlign: 'left', flex: 1 }, onClick: () => setSelectedId(parentCard.id) }, parentCard.title),
                  !archived && h('button', { type: 'button', className: 'mtb-btn', disabled: busy, onClick: () => { void setParent(task, null); } }, '解除')),
                !parentCard && h(React.Fragment, null,
                  childCards.map(child => {
                    const cCol = columns.find(c => c.key === child.status) ?? columns[1];
                    return h('div', { key: child.id, className: 'mtb-sub-row', style: { '--mtb-accent': cCol.accent } },
                      h('span', { className: 'mtb-dot' }),
                      h('button', { type: 'button', style: { border: 0, background: 'transparent', color: 'inherit', fontSize: 12, cursor: 'pointer', textAlign: 'left', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, onClick: () => setSelectedId(child.id) }, child.title),
                      h('span', { style: { fontSize: 11, color: dswTheme.dim } }, cCol.label),
                      !archived && h('button', { type: 'button', className: 'mtb-icon-btn', title: '解除子任务关联', disabled: busy, onClick: () => { void setParent(child, null); } }, '×'));
                  }),
                  !archived && h('div', { style: { display: 'flex', gap: 6 } },
                    h('input', {
                      style: { ...uiInput, padding: '5px 9px' },
                      value: newSubtaskTitle,
                      placeholder: '新建子任务标题…',
                      onChange: e => setNewSubtaskTitle(e.target.value),
                      onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); void createSubtask(task); } },
                    }),
                    h('button', { type: 'button', className: 'mtb-btn', disabled: busy || !newSubtaskTitle.trim(), onClick: () => { void createSubtask(task); } }, '＋ 子任务')),
                  !archived && linkableChildren.length > 0 && h('div', { style: { display: 'flex', gap: 6 } },
                    h('select', { style: { ...uiInput, padding: '5px 8px', flex: 1 }, value: linkChildId, onChange: e => setLinkChildId(e.target.value) },
                      h('option', { value: '' }, '关联已有卡片为子任务…'),
                      linkableChildren.map(item => h('option', { key: item.id, value: item.id }, item.title))),
                    h('button', { type: 'button', className: 'mtb-btn', disabled: busy || !linkChildId, onClick: () => { const ch = allActive.find(i => i.id === linkChildId); if (ch) void setParent(ch, task.id); } }, '关联')))),

              !archived && h('details', { className: 'mtb-drawer-sec' },
                h('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600, color: dswTheme.dim } },
                  '定时执行 (Cron / 单次)' + (task.schedule?.enabled ? ' · 已开启' : '')),
                h('div', { style: { display: 'grid', gap: 8, marginTop: 8 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 } },
                    h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                      h('input', { type: 'checkbox', checked: cronEnabled, onChange: e => setCronEnabled(e.target.checked) }),
                      '启用定时'),
                    h('select', { className: 'mtb-move', value: cronMode, onChange: e => setCronMode(e.target.value) },
                      h('option', { value: 'cron' }, '周期 Cron'),
                      h('option', { value: 'once' }, '单次触发'))),
                  cronMode === 'cron'
                    ? h(React.Fragment, null,
                        h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
                          [['每小时', '0 * * * *'], ['每天 09:00', '0 9 * * *'], ['工作日 09:30', '30 9 * * 1-5']].map(([lbl, expr]) =>
                            h('button', { key: expr, type: 'button', className: 'mtb-btn', style: { padding: '2px 8px', fontSize: 11 }, onClick: () => { setCronDraft(expr); setCronEnabled(true); } }, lbl))),
                        h('div', { style: { display: 'flex', gap: 6 } },
                          h('input', { style: { ...uiInput, padding: '5px 9px', fontFamily: 'monospace' }, value: cronDraft, placeholder: '5 段 cron，例如 0 9 * * *', onChange: e => setCronDraft(e.target.value) }),
                          h('button', { type: 'button', className: 'mtb-btn', disabled: busy, onClick: () => { void saveSchedule(task, cronEnabled, 'cron', cronDraft, onceDraft); } }, '保存定时')))
                    : h('div', { style: { display: 'flex', gap: 6 } },
                        h('input', { type: 'datetime-local', style: { ...uiInput, padding: '5px 9px' }, value: onceDraft, onChange: e => setOnceDraft(e.target.value) }),
                        h('button', { type: 'button', className: 'mtb-btn', disabled: busy, onClick: () => { void saveSchedule(task, cronEnabled, 'once', cronDraft, onceDraft); } }, '保存定时')))),

              drawerExecutions.length > 0 && h('details', { className: 'mtb-drawer-sec', open: drawerExecutions.length <= 3 },
                h('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600, color: dswTheme.dim } },
                  '执行历史（' + drawerExecutions.length + ' 条）'),
                h('div', { style: { display: 'grid', gap: 6, marginTop: 8 } },
                  drawerExecutions.map((ex, idx) => h('div', { key: ex.id || idx, className: 'mtb-exec-row' },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                      h('span', { className: 'mtb-result', 'data-tone': ex.result || 'running' },
                        ex.result ? (TASK_RESULT_LABELS[ex.result] ?? ex.result) : '运行中'),
                      ex.startedAt && h('span', { style: { color: dswTheme.dim } }, new Date(ex.startedAt).toLocaleString()),
                      ex.sessionId && h('button', { type: 'button', className: 'mtb-icon-pill', style: { marginLeft: 'auto' }, onClick: () => openSession && openSession(ex.sessionId) }, '打开会话')),
                    ex.error && h('div', { style: { color: dswTheme.danger } }, ex.error))))),

              workflow && h('div', { className: 'mtb-drawer-sec' },
                h('div', { style: { fontSize: 12, fontWeight: 600 } }, [workflow.leaderName, modeLabel,
                  catalog?.groupTemplates?.find(item => item.id === workflow.plan?.groupTemplate)?.name].filter(Boolean).join(' · ')),
                step && h('div', { role: 'status', style: uiMuted }, step),
                workflow.error && h('div', { role: 'alert', style: { color: dswTheme.danger, fontSize: 12 } }, workflow.error),
                workflow.pr && h('div', { style: uiMuted, title: workflow.pr.head },
                  h('a', { href: workflow.pr.url, target: '_blank', rel: 'noreferrer' }, 'PR'), ' · ' + workflow.pr.head.slice(0, 10),
                  workflow.pr.omitted.length > 0 ? ' · ' + workflow.pr.omitted.length + ' 个文件缺少完整文本补丁' : ''),
                workflow.reviewers?.length > 0 && h('div', { style: uiMuted },
                  workflow.reviewers.map(reviewer => reviewer.name + ' · ' + reviewer.model).join(' / ')),
                workflow.reportId && h(TaskReviewReport, { key: workflow.reportId, taskId: task.id, development: Boolean(workflow.development) }))),

            h('div', { className: 'mtb-drawer-foot' },
              !archived && task.status === 'review' && canMove && h('button', { type: 'button', className: 'mtb-btn mtb-btn-confirm', disabled: busy, onClick: () => { void confirmReview(task, Boolean(task.patchAvailable), drawerReviseNote); } }, task.patchAvailable ? '应用补丁并完成' : '确认完成'),
              !archived && task.status === 'review' && canMove && h('button', { type: 'button', className: 'mtb-btn', disabled: busy, onClick: () => { void move(task, 'todo'); } }, '移回待办'),
              !archived && !task.taskRoom?.closed && task.status !== 'running' && (!workflow || workflow.state !== 'done') && h('button', { type: 'button', disabled: busy, className: 'mtb-btn mtb-btn-accent', onClick: () => { void run(task); } }, workflow?.state === 'failed' || workflow?.state === 'interrupted' ? '重试' : '运行'),
              !archived && isRunning && !workflow && h('button', { type: 'button', className: 'mtb-btn', disabled: busy, onClick: () => { void settleTask(task); } }, '终止运行'),
              h('button', { type: 'button', className: 'mtb-btn', onClick: () => { setSelectedId(''); openTaskRoom?.(task); } }, '进入工单群'),
              !archived && (workflow || canOrchestrate) && h('button', { type: 'button', className: 'mtb-btn', disabled: busy, onClick: () => edit(task) }, workflow ? '编辑分工' : '启用编排'),
              task.sessionId && h('button', { type: 'button', className: 'mtb-btn', onClick: () => openSession && openSession(task.sessionId) }, '打开会话'),
              !archived && h('button', { type: 'button', className: 'mtb-btn', disabled: busy, onClick: () => { void duplicateTask(task); } }, '复制'),
              !archived && !isRunning && h('button', { type: 'button', className: 'mtb-btn', disabled: busy, onClick: () => { void archiveTask(task); } }, '归档'),
              archived && h('button', { type: 'button', className: 'mtb-btn mtb-btn-confirm', disabled: busy, onClick: () => { void restoreTask(task); } }, '恢复到看板'),
              !task.taskRoom && h('button', { type: 'button', className: confirmId === task.id ? 'mtb-btn mtb-btn-danger' : 'mtb-btn', style: { marginLeft: 'auto' }, onClick: () => { void remove(task); } }, confirmId === task.id ? '确认删除' : '删除'))));
      };

      const scrollToColumn = key => {
        setShowArchive(false);
        setCollapsedCols(prev => {
          if (!prev.includes(key)) return prev;
          const next = prev.filter(k => k !== key);
          try { globalThis.localStorage?.setItem('marshal.board.collapsedCols', JSON.stringify(next)); } catch {}
          return next;
        });
        setTimeout(() => {
          document.getElementById('marshal-col-' + key)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }, 30);
      };

      const canOrchestrate = Boolean(catalog?.memoryAvailable && catalog?.leaders?.length > 0);
      const topLevelParents = allActive.filter(item => item.parentId === undefined);
      const allTagSuggestions = [...new Set([...PRIORITY_TAGS, ...knownTags.map(t => t.name)])];
      const liveAmbiguityHint = !editing ? clientAmbiguityHint(title, description, formPrompt, formAttachments.length > 0, Boolean(prUrl.trim())) : '';

      return h('section', { className: 'mtb-page' },
        h('header', { className: 'mtb-head' },
          h('div', { className: 'mtb-head-left' },
            h('div', { style: { fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 } },
              '任务看板',
              h('span', { style: { fontSize: 11, fontWeight: 500, color: dswTheme.dim, fontVariantNumeric: 'tabular-nums' } },
                (activeTag || q) ? list.length + '/' + allActive.length + ' 张卡片' : allActive.length + ' 张卡片')),
            h('div', { className: 'mtb-summary', 'aria-label': '状态总览' },
              columns.map(column => {
                const count = list.filter(task => (knownStatuses.has(task.status) ? task.status : 'todo') === column.key).length;
                return h('button', {
                  key: column.key,
                  type: 'button',
                  className: 'mtb-summary-chip',
                  style: { '--mtb-accent': column.accent },
                  onClick: () => scrollToColumn(column.key),
                  title: '定位到「' + column.label + '」列',
                },
                  h('span', { className: 'mtb-dot', 'data-pulse': column.pulse && count > 0 ? 'true' : undefined }),
                  column.label,
                  h('strong', null, count));
              }),
              h('button', { type: 'button', className: 'mtb-pan-btn', 'data-active': scrollEdge.left ? 'true' : undefined, title: '向左滚动看板列', 'aria-label': '向左滚动看板列', onClick: () => panBoard(-320) }, '◀'),
              h('button', { type: 'button', className: 'mtb-pan-btn', 'data-active': scrollEdge.right ? 'true' : undefined, title: '向右滚动看板列（查看已完成/已失败）', 'aria-label': '向右滚动看板列', onClick: () => panBoard(320) }, '▶'),
              (() => {
                const emptyKeys = columns.filter(c => list.every(t => (knownStatuses.has(t.status) ? t.status : 'todo') !== c.key)).map(c => c.key);
                const allEmptyCollapsed = emptyKeys.length > 0 && emptyKeys.every(k => collapsedCols.includes(k));
                return emptyKeys.length > 0 && h('button', {
                  type: 'button',
                  className: 'mtb-summary-chip',
                  style: { '--mtb-accent': '#64748b' },
                  title: allEmptyCollapsed ? '展开所有已折叠的空列' : '将无工单的空列折叠为窄条，腾出空间查看「已完成 / 已失败」',
                  onClick: () => allEmptyCollapsed ? expandAllCols() : collapseEmptyCols(emptyKeys),
                }, allEmptyCollapsed ? '展开空列' : '收起空列');
              })(),
              collapsedCols.length > 0 && h('button', {
                type: 'button',
                className: 'mtb-summary-chip',
                style: { '--mtb-accent': '#6366f1' },
                title: '展开全部 6 列',
                onClick: expandAllCols,
              }, '全展'))),
          h('div', { className: 'mtb-head-right' },
            h('button', { type: 'button', style: uiButton(false), onClick: () => { void load(); } }, '刷新'),
            archivedTasks.length > 0 && h('button', { type: 'button', style: tabStyle(showArchive), onClick: () => setShowArchive(v => !v) },
              showArchive ? '返回看板' : '归档 (' + archivedTasks.length + ')'),
            !showArchive && h('button', { type: 'button', style: tabStyle(showFlowGuide), onClick: () => setShowFlowGuide(v => !v), title: '查看工单 6 列状态流转规则' }, '流转规则'),
            !showArchive && h('button', { type: 'button', style: uiButton(false), onClick: () => setCompactCards(v => !v) }, compactCards ? '展开卡片' : '紧凑视图'),
            openNativeBoard && h('button', { type: 'button', style: uiButton(false), onClick: () => openNativeBoard(), title: '切换到 DSH 原版任务看板' }, '原版看板'),
            h('button', { type: 'button', className: 'mtb-btn mtb-btn-ai', style: { padding: '6px 11px' }, onClick: () => { setParseError(''); setParseOpen(true); } }, '✨ AI 解析任务'),
            h('button', { type: 'button', disabled: busy, style: uiButton(true), onClick: () => formOpen ? cancelForm() : setFormOpen(true) }, formOpen ? '收起' : '＋ 新建卡片'))),

        !showArchive && h('div', { className: 'mtb-tagbar', 'aria-label': '搜索与标签筛选' },
          h('input', {
            className: 'mtb-search',
            type: 'search',
            value: searchQuery,
            onChange: e => setSearchQuery(e.target.value),
            placeholder: '搜索标题 / 描述 / 标签…',
          }),
          knownTags.length > 0 && h('span', { className: 'mtb-tagbar-label' }, '标签'),
          knownTags.length > 0 && h('button', {
            type: 'button',
            className: 'mtb-tag mtb-tag-btn',
            'data-active': activeTag === '' ? 'true' : undefined,
            onClick: () => setActiveTag(''),
          }, '全部'),
          knownTags.map(tag => h('button', {
            key: tag.name,
            type: 'button',
            className: 'mtb-tag mtb-tag-btn',
            'data-tag-tone': taskTagTone(tag.name),
            'data-active': activeTag === tag.name ? 'true' : undefined,
            onClick: () => setActiveTag(current => current === tag.name ? '' : tag.name),
          }, tag.name))),

        showFlowGuide && h('div', { style: { margin: '0 20px 8px', padding: '10px 14px', borderRadius: 10, border: '1px solid ' + dswTheme.border, background: dswTheme.layer, fontSize: 12, lineHeight: 1.65, display: 'grid', gap: 4 } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('strong', null, '工单状态流转规则'),
            h('button', { type: 'button', className: 'mtb-icon-btn', onClick: () => setShowFlowGuide(false) }, '✕')),
          h('div', { style: { color: dswTheme.dim } }, '主链路：待规划 (backlog) → 待办 (todo) → 进行中 (running) → 待确认 (review) → 已完成 (done) / 已失败 (failed)'),
          h('div', { style: { color: dswTheme.dim } }, '• 自动入「待确认」：描述模糊拦截 / 非定时工单执行完成待验收 / 派驻工作区权限受阻挂起'),
          h('div', { style: { color: dswTheme.dim } }, '• 人工拍板：「待确认」点「✓ 确认」→ 已完成，点「↩ 待办」或直接运行 → 退回修改/重跑；「已失败」可修后重试。')),
        notice && h('div', { className: 'mtb-notice', role: 'status' },
          h('span', null, notice),
          h('button', { type: 'button', className: 'mtb-icon-btn', onClick: () => setNotice('') }, '✕')),
        error && h('div', { style: { padding: '8px 20px', fontSize: 12, color: dswTheme.danger } }, error),

        formOpen && h('fieldset', { disabled: busy, 'aria-label': editing ? '编辑工单分工' : '创建工单', className: 'mtb-form' },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } },
            h('strong', { style: { fontSize: 13 } }, editing ? '编辑工单分工' : '新建任务卡片'),
            !editing && h('button', { type: 'button', className: 'mtb-btn mtb-btn-ai', onClick: () => { setParseError(''); setParseOpen(true); } }, '✨ 从文本 AI 自动解析')),
          h(Field, { label: '标题' }, h('input', { value: title, onChange: event => { setTitle(event.target.value); if (!editing) setPlan(null); }, placeholder: '这张卡片要做什么', style: uiInput })),
          h(Field, { label: '描述（建议写清目标与验收标准；可直接粘贴截图或文件；若模糊将自动转入「待确认」）' }, h('textarea', {
            value: description,
            onChange: event => { setDescription(event.target.value); if (!editing) setPlan(null); },
            onPaste: event => {
              if (uploading || busy) return;
              const pasted = Array.from(event.clipboardData?.files || []);
              if (pasted.length > 0) {
                event.preventDefault();
                void uploadFiles(pasted, added => setFormAttachments(prev => {
                  const existingIds = new Set(prev.map(a => a.attachmentId));
                  return [...prev, ...added.filter(a => !existingIds.has(a.attachmentId))].slice(0, 8);
                }));
              }
            },
            rows: 3,
            placeholder: '背景、目标、验收标准、约束（支持 ⌘/Ctrl+V 直接粘贴截图附件）…',
            style: { ...uiInput, resize: 'vertical', lineHeight: 1.6 },
          })),
          liveAmbiguityHint && h('div', { className: 'mtb-warn-hint' }, '⚠ ' + liveAmbiguityHint),

          h('details', { style: { fontSize: 12 } },
            h('summary', { style: { cursor: 'pointer', color: dswTheme.dim, fontWeight: 500 } }, '执行指令 Prompt（可选，留空自动沿用描述）'),
            h('textarea', { value: formPrompt, onChange: event => setFormPrompt(event.target.value), rows: 3, placeholder: '下发给执行智能体的具体指令…', style: { ...uiInput, marginTop: 6, resize: 'vertical', lineHeight: 1.55 } })),

          !editing && h(Field, { label: '标签与优先级（点选已有标签，或输入新建）' },
            formTags.length > 0 && h('div', { className: 'mtb-card-tags' },
              formTags.map(name => h('span', { key: name, className: 'mtb-tag', 'data-tag-tone': taskTagTone(name) },
                name,
                h('button', { type: 'button', className: 'mtb-tag-x', onClick: () => toggleFormTag(name) }, '×')))),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('input', {
                value: newTagDraft,
                onChange: event => setNewTagDraft(event.target.value),
                onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); addNewFormTag(); } },
                placeholder: '新建标签名，回车添加（如：记忆、前端、P1）',
                style: { ...uiInput, flex: 1 },
              }),
              h('button', { type: 'button', className: 'mtb-btn', onClick: addNewFormTag }, '＋ 新建标签')),
            h('div', { className: 'mtb-card-tags', style: { marginTop: 2 } },
              allTagSuggestions.map(name => h('button', {
                key: name,
                type: 'button',
                className: 'mtb-tag mtb-tag-btn',
                'data-tag-tone': taskTagTone(name),
                'data-active': formTags.includes(name) ? 'true' : undefined,
                onClick: () => toggleFormTag(name),
              }, (formTags.includes(name) ? '✓ ' : '＋ ') + name)))),

          !editing && h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: 10 } },
            (catalog?.leaders?.length ?? 0) > 0 && h(Field, { label: '指派 Agent Leader（可选）' },
              h('select', { value: assignedAgent, style: uiInput, onChange: event => handleAssignAgent(event.target.value) },
                h('option', { value: '' }, '暂不指派'),
                catalog.leaders.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
            h(Field, { label: '模型（可选）' },
              h('select', { value: formModel, style: uiInput, onChange: event => setFormModel(event.target.value) },
                modelSelectOptions((catalog?.leaders ?? []).find(l => l.id === assignedAgent)?.model || '', formModel).map(opt => h('option', { key: opt.route || '__def', value: opt.route }, opt.label)))),
            h(Field, { label: '思考模式（可选）' },
              h('select', { value: formEffort, style: uiInput, onChange: event => setFormEffort(event.target.value) },
                thinkingModeOptions(formModel || (catalog?.leaders ?? []).find(l => l.id === assignedAgent)?.model || '', (catalog?.leaders ?? []).find(l => l.id === assignedAgent)?.reasoningEffort || '', formEffort)
                  .map(opt => h('option', { key: opt.id || '__def', value: opt.id }, opt.label)))),
            h(Field, { label: '权限预设（可选）' },
              h('select', { value: formPermission, style: uiInput, onChange: event => setFormPermission(event.target.value) },
                h('option', { value: '' }, '跟随默认权限'),
                h('option', { value: 'read-only' }, '只读'),
                h('option', { value: 'workspace-write' }, '工作区可写'),
                h('option', { value: 'danger-full-access' }, '完全权限'))),
            topLevelParents.length > 0 && h(Field, { label: '关联父任务（设为子任务）' },
              h('select', { value: formParentId, style: uiInput, onChange: event => setFormParentId(event.target.value) },
                h('option', { value: '' }, '独立任务（无父任务）'),
                topLevelParents.map(item => h('option', { key: item.id, value: item.id }, (item.ticketNo ? '[' + item.ticketNo + '] ' : '') + item.title)))),
            workspaces.length > 0 && h(Field, { label: orchestrationMode === 'plain' ? '目标工作区（可选）' : '目标项目工作区（必填）' },
              h('select', { value: workspaceId, style: uiInput, onChange: event => handleSelectWorkspace(event.target.value) },
                h('option', { value: '' }, orchestrationMode === 'plain' ? '不绑定工作区' : '请选择项目工作区'),
                workspaces.map(item => h('option', { key: item.id, value: item.id }, item.name))))),

          !editing && h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: formReuseSession, onChange: event => setFormReuseSession(event.target.checked) }),
              '复用上次执行会话'),
            h('label', { className: 'mtb-btn', style: { cursor: uploading ? 'wait' : 'pointer' } },
              uploading ? '附件上传中…' : ('📎 选择附件上传（图片 / 文件' + (formAttachments.length > 0 ? ' · 已添加 ' + formAttachments.length + '/8' : '，可选') + '）'),
              h('input', {
                type: 'file', multiple: true, style: { display: 'none' }, disabled: uploading || busy || formAttachments.length >= 8,
                onChange: event => {
                  const picked = Array.from(event.target.files || []);
                  event.target.value = '';
                  void uploadFiles(picked, added => setFormAttachments(prev => {
                    const existingIds = new Set(prev.map(a => a.attachmentId));
                    return [...prev, ...added.filter(a => !existingIds.has(a.attachmentId))].slice(0, 8);
                  }));
                },
              }))),
          !editing && renderAttachments(formAttachments, attId => setFormAttachments(prev => prev.filter(a => a.attachmentId !== attId))),

          h(Field, { label: 'Agent 编排模板' },
            h('div', { className: 'mtb-tpl-grid' },
              !editing && h('button', {
                type: 'button', className: 'mtb-tpl-pill',
                'data-active': orchestrationMode === 'plain' ? 'true' : undefined,
                onClick: () => pickOrchestrationMode('plain'),
              }, '普通卡片'),
              h('button', {
                type: 'button', className: 'mtb-tpl-pill',
                disabled: !canOrchestrate,
                'data-active': orchestrationMode === 'leader' ? 'true' : undefined,
                onClick: () => pickOrchestrationMode('leader'),
              }, '由 Leader 自动选模板'),
              (catalog?.templates ?? []).map(item => h('button', {
                key: item.id,
                type: 'button',
                className: 'mtb-tpl-pill',
                disabled: !canOrchestrate,
                'data-active': orchestrationMode === 'template' && templateId === item.id ? 'true' : undefined,
                onClick: () => pickOrchestrationMode('template', item.id),
                title: item.stages.join(' → '),
              }, item.name + (item.automated ? ' · 自动' : ''))),
              h('button', {
                type: 'button', className: 'mtb-tpl-pill',
                disabled: !canOrchestrate,
                'data-active': orchestrationMode === 'none' ? 'true' : undefined,
                onClick: () => pickOrchestrationMode('none'),
              }, '仅派给 Leader（无模板）')),
            orchestrationMode === 'template' && template && h('span', { style: uiMuted }, '阶段：' + template.stages.join(' → ')),
            catalogError && h('div', { style: uiMuted }, catalogError),
            catalog && !canOrchestrate && h('div', { style: uiMuted }, '提示：需开启工作区记忆并至少有一个智能体作为 Leader，方可启用编排模板。')),

          orchestrationMode !== 'plain' && leaderId && (requiresPr || choice === 'leader') && h(Field, { label: requiresPr ? 'PR 链接' : 'PR 链接（可选）' },
            h('input', { type: 'url', value: prUrl, onChange: event => { setPrUrl(event.target.value); setPlan(null); }, placeholder: 'GitHub 或 Gitee PR 链接', style: uiInput })),

          orchestrationMode !== 'plain' && leaderId && h('section', { 'aria-label': '运行分工', style: { display: 'grid', gap: 9, borderTop: '1px solid ' + dswTheme.border, paddingTop: 10 } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
              h('strong', { style: { fontSize: 13 } }, '🤖 各参战 Agent 模型与思考模式（' + (group ? group.name : '按模板协作') + '）'),
              title.trim() && h('button', { type: 'button', className: 'mtb-btn', disabled: busy, onClick: () => { void recommend(); } }, '✨ Leader 智能推荐分工')),
            plan && recommendedTemplate && h('span', { style: uiMuted }, recommendedTemplate.name + ' · Leader ' + selectedLeader?.name),
            selectedTemplate !== 'development' && selectedTemplate !== 'pr-review' && h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 } },
              h('input', { type: 'checkbox', checked: explicitCode, onChange: event => changeCodeWork(event.target.checked) }),
              '包含编码与代码审查角色（Coder + Reviewer + Codex）'),
            h('div', { className: 'mtb-agent-cfg-list' },
              // Leader row with model & thinking mode switcher
              (() => {
                const lCfg = formAgentConfigs.leader ?? {};
                return h('div', { className: 'mtb-agent-cfg-row' },
                  h('div', { className: 'mtb-agent-cfg-head' },
                    h('span', null, '👑 Leader · ' + (selectedLeader?.name || '负责智能体'))),
                  h('div', { className: 'mtb-agent-cfg-grid' },
                    h('select', {
                      'aria-label': '选择负责 Leader',
                      style: uiInput,
                      disabled: busy,
                      value: leaderId,
                      onChange: e => handleAssignAgent(e.target.value),
                    }, (catalog?.leaders ?? []).filter(item => item.global || !workspace || item.workspaceId === workspace)
                      .map(item => h('option', { key: item.id, value: item.id }, 'Leader: ' + item.name))),
                    h('select', {
                      'aria-label': 'Leader 使用模型',
                      style: uiInput,
                      disabled: busy,
                      value: lCfg.model || '',
                      onChange: e => setSlotConfig('leader', { model: e.target.value }),
                    }, modelSelectOptions(selectedLeader?.model || '', lCfg.model || '').map(opt => h('option', { key: opt.route || '__def', value: opt.route }, opt.label))),
                    h('select', {
                      'aria-label': 'Leader 思考模式',
                      style: uiInput,
                      disabled: busy,
                      value: lCfg.reasoningEffort || '',
                      onChange: e => setSlotConfig('leader', { reasoningEffort: e.target.value }),
                    }, thinkingModeOptions(lCfg.model || selectedLeader?.model || '', selectedLeader?.reasoningEffort || '', lCfg.reasoningEffort || '').map(opt => h('option', { key: opt.id || '__def', value: opt.id }, opt.label)))));
              })(),
              // Role rows (Coder, Reviewer, Critic, Collaborator, etc.)
              (roleChoices ?? []).map(role => {
                if (role.id === 'codexCritic') {
                  const cxCfg = formAgentConfigs.codexCritic ?? {};
                  return h('div', { key: role.id, className: 'mtb-agent-cfg-row' },
                    h('div', { className: 'mtb-agent-cfg-head' }, h('span', null, '🔍 ' + role.name + '（Codex 独立审查席位）')),
                    h('div', { className: 'mtb-agent-cfg-grid' },
                      h('select', {
                        'aria-label': 'Codex 审查席位模型',
                        style: uiInput,
                        disabled: busy,
                        value: cxCfg.model || 'auto',
                        onChange: e => setSlotConfig('codexCritic', { model: e.target.value === 'auto' ? '' : e.target.value }),
                      },
                        h('option', { value: 'auto' }, '模型：自动选择 Codex'),
                        codexModels.map(m => h('option', { key: m.id, value: m.id }, 'Codex: ' + m.model))),
                      h('select', {
                        'aria-label': 'Codex 审查席位思考模式',
                        style: uiInput,
                        disabled: busy,
                        value: cxCfg.reasoningEffort || '',
                        onChange: e => setSlotConfig('codexCritic', { reasoningEffort: e.target.value }),
                      }, codexThinkingOptions(cxCfg.model || 'auto', cxCfg.reasoningEffort || '').map(opt => h('option', { key: opt.id || '__def', value: opt.id }, opt.label)))));
                }
                const assignedId = plan?.members[role.id] ?? '';
                const memberMeta = candidates.find(m => m.id === assignedId);
                const rCfg = formAgentConfigs[role.id] ?? {};
                return h('div', { key: role.id, className: 'mtb-agent-cfg-row' },
                  h('div', { className: 'mtb-agent-cfg-head' },
                    h('span', null, '🧩 ' + role.name + (memberMeta ? ' · ' + memberMeta.name : ''))),
                  h('div', { className: 'mtb-agent-cfg-grid' },
                    h('select', {
                      'aria-label': role.name + ' 指派智能体',
                      style: uiInput,
                      disabled: busy || !plan,
                      value: assignedId,
                      onChange: event => changeMember(role.id, event.target.value),
                    },
                      h('option', { value: '' }, role.required ? '待指派（必需）' : '待指派（可选）'),
                      role.id === 'critic' && h('option', { value: '@dsh' }, '独立 DSH 审查席位'),
                      candidates.filter(member => role.id !== 'coder' || ['workspace-write', 'danger-full-access'].includes(member.permission))
                        .map(member => h('option', {
                          key: member.id, value: member.id,
                          disabled: Object.entries(plan?.members ?? {}).some(([slot, id]) => slot !== role.id && id === member.id),
                        }, role.name + ': ' + member.name))),
                    h('select', {
                      'aria-label': role.name + ' 使用模型',
                      style: uiInput,
                      disabled: busy || !plan || !assignedId,
                      value: rCfg.model || '',
                      onChange: e => setSlotConfig(role.id, { model: e.target.value }),
                    }, modelSelectOptions(memberMeta?.model || '', rCfg.model || '').map(opt => h('option', { key: opt.route || '__def', value: opt.route }, opt.label))),
                    h('select', {
                      'aria-label': role.name + ' 思考模式',
                      style: uiInput,
                      disabled: busy || !plan || !assignedId,
                      value: rCfg.reasoningEffort || '',
                      onChange: e => setSlotConfig(role.id, { reasoningEffort: e.target.value }),
                    }, thinkingModeOptions(rCfg.model || memberMeta?.model || '', memberMeta?.reasoningEffort || '', rCfg.reasoningEffort || '').map(opt => h('option', { key: opt.id || '__def', value: opt.id }, opt.label)))));
              }),
              // Codex coding / review sub-agent rows
              (codeWork || selectedTemplate === 'pr-review') && (codeWork ? ['coding', 'review'] : ['review']).map(slot => {
                const cfgKey = slot === 'coding' ? 'codexCoding' : 'codexReview';
                const slotLabel = slot === 'coding' ? '⚙️ 编码 Codex 子 Agent' : '🔍 审查 Codex 子 Agent';
                const codexVal = plan ? (plan.codex[slot] ?? 'off') : 'auto';
                const cCfg = formAgentConfigs[cfgKey] ?? {};
                return h('div', { key: slot, className: 'mtb-agent-cfg-row' },
                  h('div', { className: 'mtb-agent-cfg-head' }, h('span', null, slotLabel)),
                  h('div', { className: 'mtb-agent-cfg-grid' },
                    h('select', {
                      'aria-label': slotLabel + ' 模型',
                      style: uiInput,
                      disabled: busy || !plan,
                      value: codexVal,
                      onChange: event => {
                        const nextVal = event.target.value === 'off' ? null : event.target.value;
                        setPlan(current => ({ ...current, codex: { ...current.codex, [slot]: nextVal } }));
                        setSlotConfig(cfgKey, { model: nextVal && nextVal !== 'auto' ? nextVal : '' });
                      },
                    },
                      h('option', { value: 'auto' }, '自动选择 · 按需调用'),
                      h('option', { value: 'off' }, '关闭子调用'),
                      plan?.codex[slot] && plan.codex[slot] !== 'auto' && !codexModels.some(model => model.id === plan.codex[slot]) &&
                        h('option', { value: plan.codex[slot] }, plan.codex[slot]),
                      codexModels.filter(model => slot !== 'coding' || model.work).map(model =>
                        h('option', { key: model.id, value: model.id }, 'Codex: ' + model.model))),
                    h('select', {
                      'aria-label': slotLabel + ' 思考模式',
                      style: uiInput,
                      disabled: busy || !plan || codexVal === 'off',
                      value: cCfg.reasoningEffort || '',
                      onChange: e => setSlotConfig(cfgKey, { reasoningEffort: e.target.value }),
                    }, codexThinkingOptions(codexVal, cCfg.reasoningEffort || '').map(opt => h('option', { key: opt.id || '__def', value: opt.id }, opt.label)))));
              }))),

          error && h('div', { role: 'alert', style: { padding: '7px 10px', borderRadius: 8, fontSize: 12, color: dswTheme.danger, background: 'color-mix(in srgb, #ef4444 10%, transparent)', border: '1px solid color-mix(in srgb, #ef4444 28%, transparent)' } }, error),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            h('button', { type: 'button', style: uiButton(false), onClick: cancelForm }, '取消'),
            orchestrationMode !== 'plain' && leaderId && plan && h('button', { type: 'button', style: uiButton(false), disabled: busy, onClick: () => { void recommend(); } }, '重新推荐'),
            h('button', { type: 'button', disabled: busy || uploading, style: { ...uiButton(true), opacity: busy || uploading ? .6 : 1 }, onClick: () => { void create(); } },
              busy ? '处理中…' : orchestrationMode !== 'plain' && leaderId && !plan ? 'Leader 推荐分工' : editing ? '保存分工' : '创建'))),

        showArchive
          ? h('div', { className: 'mtb-archive-grid' },
              archivedTasks.length === 0
                ? h(EmptyState, { title: '没有已归档卡片', hint: '已完成或失败的卡片可在详情中归档。', action: '返回看板', onAction: () => setShowArchive(false) })
                : archivedTasks.map(task => {
                    const col = columns.find(c => c.key === task.status) ?? columns[4];
                    return h('article', { key: task.id, className: 'mtb-card', style: { '--mtb-accent': col.accent }, onClick: () => setSelectedId(task.id) },
                      h('div', { className: 'mtb-card-title-row' }, h('span', { className: 'mtb-card-title' }, task.title)),
                      Array.isArray(task.tags) && task.tags.length > 0 && h('div', { className: 'mtb-card-tags' },
                        task.tags.map(tag => h('span', { key: tag.name, className: 'mtb-tag', 'data-tag-tone': taskTagTone(tag.name) }, tag.name))),
                      h('div', { className: 'mtb-card-foot' },
                        h('span', { className: 'mtb-runs' }, '归档于 ' + formatTaskTime(task.archivedAt)),
                        h('button', { type: 'button', className: 'mtb-icon-pill mtb-icon-pill-confirm', onClick: e => { e.stopPropagation(); void restoreTask(task); } }, '恢复')));
                  }))
          : allActive.length === 0 && !formOpen
            ? h(EmptyState, { title: '还没有卡片', hint: '新建一张卡片，或点上方「✨ AI 解析任务」快速生成。', action: '新建卡片', onAction: () => setFormOpen(true) })
            : h('div', { className: 'mtb-grid-wrap' },
                scrollEdge.left && h('button', { type: 'button', className: 'mtb-edge-pan mtb-edge-pan-left', title: '向左查看前面列', onClick: () => panBoard(-340) }, '← 前列'),
                scrollEdge.right && h('button', { type: 'button', className: 'mtb-edge-pan mtb-edge-pan-right', title: '向右查看已完成 / 已失败列', onClick: () => panBoard(340) }, '已完成 / 失败 →'),
                h('div', {
                  ref: gridRef,
                  className: 'mtb-grid',
                  'data-panning': panning ? 'true' : undefined,
                  onMouseDown: handleGridMouseDown,
                  onWheel: handleGridWheel,
                  onDragOver: handleGridDragOver,
                },
                columns.map(column => {
                  const items = list.filter(task => (knownStatuses.has(task.status) ? task.status : 'todo') === column.key);
                  const collapsed = collapsedCols.includes(column.key);
                  return h('section', {
                    key: column.key,
                    id: 'marshal-col-' + column.key,
                    className: 'mtb-col',
                    'data-status': column.key,
                    'data-collapsed': collapsed ? 'true' : undefined,
                    'data-drop': dropCol === column.key ? 'true' : undefined,
                    style: { '--mtb-accent': column.accent },
                    onClick: collapsed ? () => toggleCollapseCol(column.key) : undefined,
                    title: collapsed ? '点击展开「' + column.label + '」列（拖拽卡片到此也可直接流转）' : undefined,
                    onDragOver: event => {
                      if (!dragTaskId) return;
                      event.preventDefault();
                      handleGridDragOver(event);
                      if (dropCol !== column.key) setDropCol(column.key);
                    },
                    onDragLeave: event => {
                      if (dropCol === column.key && !event.currentTarget.contains(event.relatedTarget)) setDropCol('');
                    },
                    onDrop: event => {
                      event.preventDefault();
                      const droppedId = dragTaskId || event.dataTransfer?.getData('text/plain') || '';
                      setDropCol('');
                      setDragTaskId('');
                      const target = allActive.find(item => item.id === droppedId);
                      if (target && target.status !== column.key) void move(target, column.key);
                    },
                  },
                    collapsed
                      ? [
                          h('span', { key: 'd', className: 'mtb-dot', 'data-pulse': column.pulse && items.length > 0 ? 'true' : undefined }),
                          h('span', { key: 'c', className: 'mtb-count', style: { padding: '1px 6px' } }, items.length),
                          h('span', { key: 't', className: 'mtb-col-rail-title' }, column.label),
                        ]
                      : [
                          h('div', { key: 'h', className: 'mtb-col-head' },
                            h('span', { className: 'mtb-dot', 'data-pulse': column.pulse && items.length > 0 ? 'true' : undefined }),
                            h('h2', { className: 'mtb-col-title', style: { margin: 0 } }, column.label),
                            h('span', { className: 'mtb-count' }, items.length),
                            h('button', {
                              type: 'button',
                              className: 'mtb-icon-btn',
                              style: { width: 20, height: 20, fontSize: 12 },
                              title: '折叠「' + column.label + '」列以腾出空间',
                              'aria-label': '折叠' + column.label,
                              onClick: event => { event.stopPropagation(); toggleCollapseCol(column.key); },
                            }, '‹')),
                          h('div', { key: 'b', className: 'mtb-col-body' },
                            items.length === 0
                              ? h('div', { className: 'mtb-empty' }, column.empty)
                              : items.map(task => card(task, column))),
                        ]);
                }))),
        renderDrawer(),
        renderParseModal());
    }
