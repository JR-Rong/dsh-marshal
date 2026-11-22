    const marshalVnextCss = `
.mv-scope,.mv-entry {
  --mv-light-surface:#fff; --mv-dark-surface:#252529;
  --mv-light-layer:#f2f4f7; --mv-dark-layer:#232327;
  --mv-light-text:#0f1115; --mv-dark-text:#f5f6f8;
  --mv-light-muted:#585e66; --mv-dark-muted:#c4c8ce;
  --mv-light-accent:#1f6feb; --mv-dark-accent:#84b4ff;
  --mv-light-danger:#b82222; --mv-dark-danger:#ff9292;
  --mv-light-success:#167640; --mv-dark-success:#72dba2;
  --dsw-alias-marshal-surface:var(--dsw-bg-card-elevated,light-dark(var(--mv-light-surface),var(--mv-dark-surface)));
  --dsw-alias-marshal-layer:var(--dsw-bg-module,light-dark(var(--mv-light-layer),var(--mv-dark-layer)));
  --dsw-alias-marshal-text:var(--dsw-alias-label-primary,light-dark(var(--mv-light-text),var(--mv-dark-text)));
  --dsw-alias-marshal-muted:var(--dsw-alias-label-secondary,light-dark(var(--mv-light-muted),var(--mv-dark-muted)));
  --dsw-alias-marshal-border:color-mix(in srgb,var(--dsw-alias-marshal-text) 15%,transparent);
  --dsw-alias-marshal-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent));
  --dsw-alias-marshal-accent:light-dark(var(--mv-light-accent),var(--mv-dark-accent));
  --dsw-alias-marshal-danger:var(--dsw-alias-state-error-primary,light-dark(var(--mv-light-danger),var(--mv-dark-danger)));
  --dsw-alias-marshal-success:light-dark(var(--mv-light-success),var(--mv-dark-success));
  --dsw-alias-marshal-tint:color-mix(in srgb,var(--dsw-alias-marshal-accent) 12%,transparent);
  --dsw-alias-marshal-shadow:var(--dsw-shadow-md,0 6px 20px #0f111524);
  --mv-xs:4px; --mv-sm:8px; --mv-md:12px; --mv-lg:16px; --mv-xl:24px;
  --mv-radius:12px; --mv-pill:999px; --mv-control:30px; --mv-avatar-size:28px;
  --mv-font-small:12px; --mv-font:13px; --mv-font-title:14px; --mv-weight:600; --mv-leading:1.5;
  --mv-float-width:360px; --mv-float-top:max(64px,var(--dsh-frame-overlay-top,0px));
  --mv-composer-clearance:120px; --mv-float-z:30; --mv-breath:2.8s;
  color-scheme:light;
}
[data-ds-dark-theme] :is(.mv-scope,.mv-entry),[data-theme="dark"] :is(.mv-scope,.mv-entry){color-scheme:dark}
:root[data-ds-theme-source] :is(.mv-scope,.mv-entry){color-scheme:inherit}
@media(prefers-color-scheme:dark){
  :root:not([data-ds-theme-source],[data-theme="light"]) body:not([data-ds-light-theme],[data-theme="light"]) :is(.mv-scope,.mv-entry){color-scheme:dark}
}
.mv-scope{color:var(--dsw-alias-marshal-text);font-size:var(--mv-font);line-height:var(--mv-leading)}
.mv-entry,.mv-line,.mv-actions{display:flex;align-items:center;gap:var(--mv-sm);min-width:0}
.mv-entry{position:relative;display:inline-flex}
.mv-entry .mv-badge{position:absolute;inset-block-start:calc(-1 * var(--mv-xs));inset-inline-start:100%;pointer-events:none}
.mv-badge,.mv-model{font-size:var(--mv-font-small);border-radius:var(--mv-pill);padding-inline:var(--mv-xs)}
.mv-badge{color:var(--dsw-alias-marshal-danger);background:var(--dsw-alias-marshal-surface);font-weight:var(--mv-weight);box-shadow:0 0 0 1px var(--dsw-alias-marshal-border)}
.mv-model{color:var(--dsw-alias-marshal-muted);background:var(--dsw-alias-marshal-layer);display:block;width:fit-content;max-width:100%;box-sizing:border-box}
.mv-stack,.mv-sections,.mv-agent-card{display:grid;gap:var(--mv-sm);min-width:0}
.mv-sections{padding:var(--mv-sm) var(--mv-md)}
.mv-session-actions{flex:1;min-width:0}.mv-native-session{display:flex;align-items:center;gap:var(--mv-xs);min-width:0}
.mv-agent-card,.mv-mini{margin-block:var(--mv-xs);padding:var(--mv-sm);border:1px solid var(--dsw-alias-marshal-border);border-radius:var(--mv-radius);background:var(--dsw-alias-marshal-surface)}
.mv-agent-card[data-compact="true"]{justify-items:center;padding:var(--mv-xs)}
.mv-agent-card[data-compact="true"] .mv-actions{flex-direction:column;justify-content:center;gap:var(--mv-xs)}
.mv-copy{min-width:0;flex:1}.mv-truncate{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mv-muted{color:var(--dsw-alias-marshal-muted);font-size:var(--mv-font-small)}
.mv-btn,.mv-row{box-sizing:border-box;display:inline-flex;align-items:center;gap:var(--mv-xs);min-height:var(--mv-control);padding:var(--mv-xs) var(--mv-sm);border:1px solid var(--dsw-alias-marshal-border);border-radius:var(--mv-radius);background:transparent;color:inherit;font:inherit;cursor:pointer}
.mv-btn:hover:not(:disabled),.mv-row:hover:not(:disabled){background:var(--dsw-alias-marshal-hover)}
.mv-btn:focus-visible,.mv-row:focus-visible,.mv-field:focus-visible{outline:2px solid var(--dsw-alias-marshal-accent);outline-offset:1px}
.mv-btn:disabled,.mv-row:disabled{opacity:.6;cursor:default}
.mv-icon-button{justify-content:center;min-width:var(--mv-control);padding:var(--mv-xs)}
.mv-row{width:100%;border-color:transparent;text-align:start}.mv-section-label{font-weight:var(--mv-weight)}
.mv-row-list{list-style:none;margin:0;padding:0;padding-inline-start:var(--mv-sm)}
.mv-avatar{flex:none;display:grid;place-items:center;width:var(--mv-avatar-size);height:var(--mv-avatar-size);border-radius:var(--mv-pill);color:var(--dsw-alias-marshal-accent);background:var(--dsw-alias-marshal-tint);font-weight:var(--mv-weight)}
.mv-svg{flex:none}.mv-online{color:var(--dsw-alias-marshal-success)}.mv-danger{color:var(--dsw-alias-marshal-danger)}
/* Only the card and capsule take hits; neither is attached to the host composer. */
.mv-voice-dock{position:fixed;top:var(--mv-float-top);inset-inline-end:var(--mv-lg);z-index:var(--mv-float-z);width:min(var(--mv-float-width),calc(100vw - 2 * var(--mv-lg)));display:grid;justify-items:end;gap:var(--mv-sm)}
.mv-voice-dock,[data-shell-overlay]>.mv-voice-dock{pointer-events:none}
.mv-voice-dock>*{pointer-events:auto;box-sizing:border-box}
.mv-capsule,.mv-voice-panel,.mv-summary-card,.mv-drawer,.mv-dialog{background:var(--dsw-alias-marshal-surface);border:1px solid var(--dsw-alias-marshal-border);box-shadow:var(--dsw-alias-marshal-shadow)}
.mv-capsule{border-radius:var(--mv-pill);padding-inline:var(--mv-md)}
.mv-voice-panel,.mv-summary-card,.mv-drawer,.mv-dialog{width:100%;padding:var(--mv-md);border-radius:var(--mv-radius);overflow:auto}
.mv-voice-panel,.mv-summary-card{max-height:calc(100vh - var(--mv-float-top) - var(--mv-control) - var(--mv-sm) - var(--mv-composer-clearance));overscroll-behavior:contain}
.mv-summary-card{border-inline-start:3px solid var(--dsw-alias-marshal-accent)}
.mv-voice-title{font-size:var(--mv-font-title);margin:0}.mv-time{font-variant-numeric:tabular-nums}
.mv-voice-panel .mv-avatar[data-breathing="true"]{animation:mv-breath var(--mv-breath) ease-in-out infinite}
@keyframes mv-breath{50%{box-shadow:0 0 0 var(--mv-xs) var(--dsw-alias-marshal-tint)}}
@media(prefers-reduced-motion:reduce){.mv-voice-panel .mv-avatar[data-breathing]{animation:none}}
.mv-field,.mv-transcript{box-sizing:border-box;width:100%;padding:var(--mv-sm);border-radius:var(--mv-radius);border:1px solid var(--dsw-alias-marshal-border);background:var(--dsw-alias-marshal-layer);color:inherit;font:inherit}
.mv-field{resize:vertical}.mv-transcript{max-height:calc(5 * var(--mv-xl));overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap}
.mv-actions{flex-wrap:wrap}.mv-drawer{max-width:var(--mv-float-width);height:100%}.mv-dialog{max-width:var(--mv-float-width)}
.mv-room{display:flex;flex:1;flex-direction:column;gap:var(--mv-md);padding:var(--mv-lg);min-width:0;min-height:0;overflow:auto}
.mv-room-fill{display:flex;flex:1;min-height:0;min-width:0}.mv-room-log{flex:1;overflow:auto;min-height:0}
.mv-routed{flex:1;grid-template-rows:auto minmax(0,1fr);min-height:0}.mv-routed>header{padding:var(--mv-sm) var(--mv-md)}
.mv-room-message{padding:var(--mv-sm);margin-block-end:var(--mv-sm);background:var(--dsw-alias-marshal-layer);border-radius:var(--mv-radius);white-space:pre-wrap;overflow-wrap:anywhere}
.mv-task-pane{height:100%;box-sizing:border-box;padding:var(--mv-md);grid-template-rows:auto auto minmax(0,1fr) auto;overflow:auto;overflow-wrap:anywhere}
.mv-task-scroll{overflow:auto;align-content:start;min-height:calc(2 * var(--mv-control));overscroll-behavior:contain}
.mv-task-item{padding:var(--mv-sm);border:1px solid var(--dsw-alias-marshal-border);border-radius:var(--mv-radius)}
.mv-task-item[data-focused="true"],.mv-casual-card[aria-pressed="true"],.mv-chip[aria-pressed="true"],.mv-guidance-action{background:var(--dsw-alias-marshal-tint);border-color:var(--dsw-alias-marshal-accent)}
.mv-casual-card{font-weight:var(--mv-weight)}
.mv-chip{border-radius:var(--mv-pill)}
.mv-compact-field{width:auto;max-width:100%}
.mv-composer-dock{gap:var(--mv-xs);padding-inline:var(--mv-xs);font-size:var(--mv-font-small)}
.mv-composer-dock .mv-btn{border:0;min-height:var(--mv-xl)}
.mv-composer-dock .mv-truncate{max-width:50%}
.mv-guidance-dialog{box-sizing:border-box;max-width:min(var(--mv-float-width),calc(100vw - 2 * var(--mv-lg)));max-height:calc(100vh - 2 * var(--mv-xl));overscroll-behavior:contain}
.mv-guidance-dialog::backdrop{background:color-mix(in srgb,currentColor 35%,transparent)}
`;

    const marshalVnextStyleRefs = new WeakMap();
    function ensureMarshalVnextStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {};
      let style = document.getElementById('marshal-vnext-styles');
      if (!style) {
        style = document.createElement('style');
        style.id = 'marshal-vnext-styles';
        style.textContent = marshalVnextCss;
        document.head.appendChild(style);
        marshalVnextStyleRefs.set(style, 0);
      }
      if (!marshalVnextStyleRefs.has(style)) return () => {};
      marshalVnextStyleRefs.set(style, marshalVnextStyleRefs.get(style) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const refs = marshalVnextStyleRefs.get(style) - 1;
        if (refs) marshalVnextStyleRefs.set(style, refs);
        else { marshalVnextStyleRefs.delete(style); style.remove(); }
      };
    }
