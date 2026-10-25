/** Dashboard design system: bordered surfaces on one spacing/radius/type scale, a fluid
 *  horizontal board, and a bounded project dropdown. Host aliases stay the source of truth
 *  when present; fallbacks keep the isolated fixture honest. */
export const dashboardCss = `
.sd-root, .sd-overlay, .sd-completion-toast, .sd-statepanel, .sd-facet-panel{
  --sd-bg:var(--dsw-alias-bg-base,#fff);
  --sd-surface:var(--dsw-alias-bg-layer-1,#f6f7f9);
  --sd-surface-2:#eceff4;
  --sd-elevated:var(--dsw-alias-bg-base,#fff);
  --sd-border:var(--dsw-alias-border-l3,#e3e7ee);
  --sd-border-strong:#cfd6e2;
  --sd-text:var(--dsw-alias-label-primary,#1b2130);
  --sd-muted:var(--dsw-alias-label-secondary,#5d6779);
  --sd-faint:#606a78;
  --sd-accent:var(--dsw-alias-brand-primary,#4f63c8);
  --sd-accent-soft:#4f63c814;
  --sd-accent-ink:#3b4ca8;
  --sd-on-accent:var(--dsw-alias-label-primary-foreground,#fff);
  --sd-info:#3d6fb5;
  --sd-warn:#a9701a;
  --sd-ok:#2f8f63;
  --sd-danger:#c0392b;
  --sd-radius-sm:7px;
  --sd-radius:11px;
  --sd-radius-lg:16px;
  --sd-1:4px;--sd-2:8px;--sd-3:12px;--sd-4:16px;--sd-5:24px;--sd-6:32px;
  --sd-shadow-1:0 1px 2px #1018280a,0 1px 3px #1018280f;
  --sd-shadow-2:0 6px 16px #10182814,0 16px 44px #1018281f;
}
/* Only the dashboard shells paint the document surface; the portalled panel gets the
   variables above but keeps its own surface, size and stacking. */
.sd-root, .sd-overlay, .sd-completion-toast{
  color-scheme:light;
  box-sizing:border-box;
  color:var(--sd-text);
  background:var(--sd-bg);
  font:13px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  height:100%;min-height:0;min-width:0;
  display:flex;flex-direction:column;position:relative;isolation:isolate;
  -webkit-font-smoothing:antialiased;
}
.sd-root *{box-sizing:border-box}
.sd-root h1,.sd-root h2,.sd-root h3,.sd-root p{margin:0}
.sd-root h1{font-size:22px;line-height:1.25;font-weight:640;letter-spacing:-.02em}
.sd-root h2{font-size:15px;line-height:1.35;font-weight:620;letter-spacing:-.01em}
.sd-root h3{font-size:13px;line-height:1.4;font-weight:620}
.sd-root button,.sd-root input,.sd-root select,.sd-root textarea{font:inherit;color:inherit}
/* Bordered controls by default; only the primary action fills with the accent colour. */
.sd-root button{
  cursor:pointer;min-height:30px;padding:0 10px;
  border:1px solid var(--sd-border);border-radius:var(--sd-radius-sm);
  background:var(--sd-elevated);white-space:normal;
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  transition:background .12s ease,border-color .12s ease,color .12s ease,box-shadow .12s ease;
}
.sd-root button:hover:not(:disabled){background:var(--sd-surface);border-color:var(--sd-border-strong)}
.sd-root button:active:not(:disabled){background:var(--sd-surface-2)}
.sd-root button:disabled{cursor:not-allowed;opacity:.45}
.sd-root :focus-visible{outline:2px solid var(--sd-accent);outline-offset:2px}
.sd-root input:not([type=checkbox]):not([type=radio]):not([type=color]),.sd-root select,.sd-root textarea{
  border:1px solid var(--sd-border);border-radius:var(--sd-radius-sm);
  background:var(--sd-elevated);padding:6px var(--sd-2);min-width:0;max-width:100%;
  transition:background .12s ease,border-color .12s ease,box-shadow .12s ease;
}
.sd-root input:not([type=checkbox]):not([type=radio]):not([type=color]):hover:not(:disabled),.sd-root select:hover:not(:disabled){background:var(--sd-surface)}
.sd-root input:not([type=checkbox]):not([type=radio]):not([type=color]):focus,.sd-root select:focus,.sd-root textarea:focus{border-color:var(--sd-accent);background:var(--sd-elevated);box-shadow:0 0 0 3px var(--sd-accent-soft);outline:none}
.sd-root input[type=checkbox],.sd-root input[type=radio]{accent-color:var(--sd-accent);width:14px;height:14px;margin:0}
.sd-root textarea{width:100%;resize:vertical;min-height:84px}
.sd-primary{background:var(--sd-accent)!important;border-color:var(--sd-accent)!important;color:var(--sd-on-accent)!important;font-weight:560}
.sd-primary:hover:not(:disabled){background:var(--sd-accent)!important;border-color:var(--sd-accent)!important;filter:brightness(1.07)}
.sd-danger{color:var(--sd-danger)!important}
.sd-muted{color:var(--sd-muted)}
.sd-small{font-size:11.5px;line-height:1.5}
.sd-row{display:flex;align-items:center;gap:var(--sd-2);flex-wrap:wrap;min-width:0}
.sd-between{display:flex;justify-content:space-between;align-items:center;gap:var(--sd-3);min-width:0}
.sd-stack{display:flex;flex-direction:column;gap:var(--sd-3);min-width:0}

/* ---- shell ---- */
.sd-head{
  padding:var(--sd-4) var(--sd-5) 0;
  padding-left:max(var(--sd-5),var(--dsh-frame-leading-clearance,0px));
  padding-right:max(var(--sd-5),var(--dsh-frame-trailing-clearance,0px));
  flex-shrink:0;display:flex;flex-direction:column;gap:var(--sd-3);
}
.sd-titlebar{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--sd-4);flex-wrap:wrap}
.sd-titleblock{display:flex;flex-direction:column;gap:2px;min-width:0}
.sd-eyebrow{font-size:10.5px;font-weight:620;letter-spacing:.09em;text-transform:uppercase;color:var(--sd-faint)}
.sd-subtitle{color:var(--sd-muted);font-size:12px;max-width:64ch}
.sd-actions{display:flex;align-items:center;gap:var(--sd-1);flex:none}
.sd-actions button{min-height:32px}
.sd-icon-btn{width:30px;min-width:30px;padding:0!important;font-size:16px;line-height:1;color:var(--sd-muted)}
/* three-dot trigger: persistent, quiet, and never wider than the dots */
.sd-root .sd-kebab{width:30px;min-width:30px;min-height:30px;padding:0;color:var(--sd-muted);border-radius:var(--sd-radius-sm)}
.sd-root .sd-kebab:hover:not(:disabled){color:var(--sd-text)}
.sd-root .sd-kebab[aria-expanded=true]{color:var(--sd-accent-ink);background:var(--sd-accent-soft);border-color:#4f63c840}
.sd-more{display:block}

/* navigation: quiet pills, not underlined text */
.sd-bucket{margin-top:var(--sd-4);border-top:1px dashed var(--sd-border);padding-top:var(--sd-3);display:flex;flex-direction:column;gap:var(--sd-2)}
.sd-buckethead{display:flex;align-items:baseline;gap:var(--sd-3);flex-wrap:wrap}
.sd-buckettoggle{display:flex;align-items:center;gap:7px;border:0;background:transparent;padding:0;min-height:26px;color:var(--sd-text)}
.sd-buckettoggle:hover:not(:disabled){background:transparent;border:0;color:var(--sd-accent-ink)}
.sd-bucketcaret{display:inline-block;font-size:10px;color:var(--sd-muted);transition:transform .12s ease}
.sd-buckettoggle[aria-expanded=true] .sd-bucketcaret{transform:rotate(90deg)}
.sd-bucket .sd-projectdrop-list{border:1px solid var(--sd-border);border-radius:var(--sd-radius);background:var(--sd-surface);padding:var(--sd-2);max-height:320px;overflow:auto}

/* ---- toolbar: one fluid row, rare controls compressed into popovers ---- */
.sd-toolbar{
  padding:var(--sd-2) var(--sd-5) var(--sd-2);
  padding-left:max(var(--sd-5),var(--dsh-frame-leading-clearance,0px));
  padding-right:max(var(--sd-5),var(--dsh-frame-trailing-clearance,0px));
  display:flex;flex-direction:column;gap:var(--sd-2);
  border-bottom:1px solid var(--sd-border);background:var(--sd-bg);
  position:sticky;top:0;z-index:6;flex-shrink:0;
}
.sd-toolbar-main{display:flex;align-items:center;gap:var(--sd-2);row-gap:var(--sd-2);flex-wrap:wrap}
.sd-summary{color:var(--sd-muted);font-size:11.5px;font-variant-numeric:tabular-nums}
.sd-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none;background:var(--label-color,var(--sd-muted))}

/* ---- popovers: rare controls in an elevated, bordered surface ---- */
.sd-popwrap{position:relative;display:inline-flex;flex:none}
.sd-pop{
  position:absolute;top:calc(100% + 6px);z-index:40;
  min-width:224px;max-width:min(92vw,360px);max-height:min(70vh,540px);overflow:auto;
  background:var(--sd-elevated);border:1px solid var(--sd-border);border-radius:var(--sd-radius-lg);padding:6px;
  box-shadow:var(--sd-shadow-2);display:flex;flex-direction:column;gap:1px;
  animation:sd-pop-in .1s ease-out;
}
.sd-pop[data-align=end]{right:0}
.sd-pop[data-align=start]{left:0}
.sd-pop:focus-visible{outline:none}
@keyframes sd-pop-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.sd-menu-item{width:100%;justify-content:flex-start!important;text-align:left!important;min-height:30px;padding:0 10px!important;border:0!important;border-radius:var(--sd-radius-sm)!important;font-size:12.5px;color:var(--sd-text);background:transparent!important}
.sd-menu-item:hover:not(:disabled){background:var(--sd-surface)!important}
.sd-root .sd-menu-item[aria-pressed=true]{background:var(--sd-accent-soft)!important;color:var(--sd-accent-ink)}

/* ---- operation toasts: fixed top-right, out of the layout flow ---- */
.sd-toasts{
  position:fixed;top:max(12px,env(safe-area-inset-top));right:max(12px,var(--dsh-frame-trailing-clearance,0px));z-index:70;
  display:flex;flex-direction:column;gap:8px;width:min(360px,calc(100vw - 24px));max-height:calc(100vh - 24px);
  overflow-y:auto;pointer-events:none;padding:2px;
}
.sd-toast{
  /* The card body stays click-through so an overlaid toast never blocks the
     control underneath; its action buttons remain interactive. */
  pointer-events:none;display:flex;flex-direction:column;gap:6px;padding:9px var(--sd-3);
  border:1px solid var(--sd-border);border-left:3px solid var(--sd-accent);border-radius:var(--sd-radius);
  background:var(--sd-elevated);box-shadow:var(--sd-shadow-2);font-size:12.5px;line-height:1.45;overflow-wrap:anywhere;
}
.sd-toast.sd-error{border-color:#d86e6e55;border-left-color:#c0392b;background:var(--sd-elevated);color:var(--sd-text)}
.sd-toast-text{margin:0}
.sd-toast-actions{display:flex;justify-content:flex-end;align-items:center;gap:var(--sd-2);pointer-events:auto}
.sd-toast-actions button{min-height:26px;padding:0 var(--sd-2);background:var(--sd-surface)}
.sd-toast-close{min-width:26px;padding:0!important;font-size:14px;line-height:1;background:transparent!important;color:var(--sd-muted)}
.sd-error{border-color:#d86e6e55;background:#c0392b0d;color:#a13024}
/* ---- workspace picker ---- */
.sd-workspace-list{display:flex;flex-direction:column;gap:2px;max-height:320px;overflow-y:auto;border:1px solid var(--sd-border);border-radius:var(--sd-radius);padding:var(--sd-2);background:var(--sd-surface)}
.sd-workspace-list:focus-visible{outline:2px solid var(--sd-accent);outline-offset:2px}
.sd-workspace-option{display:flex;align-items:flex-start;gap:8px;padding:6px var(--sd-2);border-radius:var(--sd-radius-sm);cursor:pointer}
.sd-workspace-option:hover,.sd-workspace-option[data-selected=true]{background:var(--sd-accent-soft)}
.sd-workspace-option input{margin-top:3px}
.sd-workspace-option>span{display:flex;flex-direction:column;gap:1px;min-width:0}
/* ---- New Session dialog (workspace, mode, model, optional prompt) ---- */
.sd-modal[data-wide=true]{width:min(900px,100%)}
.sd-new-session{gap:14px}
.sd-new-session-section{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--sd-border);border-radius:var(--sd-radius-lg);background:var(--sd-surface)}
.sd-new-session-head{display:flex;flex-direction:column;gap:2px;min-width:0}
.sd-new-session-head h3,.sd-new-session-head h4{margin:0;font-size:13px;font-weight:650;line-height:1.35}
.sd-new-session-head h4{font-size:12px;color:var(--sd-muted)}
.sd-new-session .sd-workspace-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px;max-height:260px;padding:6px;background:transparent}
.sd-new-session .sd-workspace-option{padding:9px 10px;border:1px solid transparent;align-items:center;min-width:0}
.sd-new-session .sd-workspace-option[data-selected=true]{border-color:var(--sd-accent);background:var(--sd-accent-soft)}
.sd-workspace-check{margin-left:auto;color:var(--sd-accent);font-weight:700;flex:none}
.sd-workspace-create{display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px dashed var(--sd-border-strong)}
.sd-workspace-create>.sd-row{align-items:flex-end;gap:8px;flex-wrap:wrap}
.sd-workspace-path{flex:1 1 260px}
.sd-new-session-options{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;padding:14px;border:1px solid var(--sd-border);border-radius:var(--sd-radius-lg);background:var(--sd-surface)}
.sd-new-session-options .sd-formfield select{width:100%;min-width:0}
.sd-new-session-options .sd-formfield small{color:var(--sd-muted);font-size:11px;line-height:1.45}
@media (max-width:700px){.sd-new-session-options{grid-template-columns:1fr}.sd-new-session .sd-workspace-list{grid-template-columns:1fr}}


/* ---- official New Session frame: the same floating native window as a preview ---- */
.sd-official-overlay{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;padding:12px;background:#0b0f1ad9;backdrop-filter:blur(2px)}
/* Mirrors .sd-preview-pane: 1000px wide window, 92vh cap, and the native page
   itself keeps the shared .sd-native-page-wrap height, so the host's own UI and
   the preview never disagree about size. */
.sd-official{display:flex;flex-direction:column;gap:8px;width:1000px;min-width:0;max-width:min(1000px,100%);max-height:92vh;padding:var(--sd-4);border:1px solid var(--sd-border);border-radius:var(--sd-radius-lg);background:var(--sd-elevated);box-shadow:0 24px 80px #0b0f1a3d;overflow:auto}
.sd-official-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--sd-3);min-width:0}
.sd-official-head h2{font-size:15px;margin:0}
.sd-official-foot{flex:none;display:flex;flex-direction:column;gap:6px;padding-top:var(--sd-2);border-top:1px solid var(--sd-border);position:sticky;bottom:0;background:var(--sd-elevated)}
.sd-official-confirm{display:flex;flex-direction:column;gap:6px}
/* ---- content ---- */
.sd-scroll{
  overflow:auto;min-height:0;flex:1;
  padding:var(--sd-3) var(--sd-4) var(--sd-6);
  padding-left:max(var(--sd-4),var(--dsh-frame-leading-clearance,0px));
  padding-right:max(var(--sd-4),var(--dsh-frame-trailing-clearance,0px));
  overscroll-behavior:contain;
}
.sd-empty{padding:var(--sd-6) var(--sd-5);text-align:center;color:var(--sd-muted);border:1px dashed var(--sd-border);border-radius:var(--sd-radius-lg);display:flex;flex-direction:column;align-items:center;gap:var(--sd-2)}
.sd-empty h2{color:var(--sd-text)}
.sd-empty button{margin-top:var(--sd-2);background:var(--sd-elevated)}

/* ---- projects overview: fixed-width tiles in wrapping rows; sessions open in a bounded dropdown ---- */
.sd-projectgrid{display:flex;flex-direction:column;gap:var(--sd-2);min-width:0}
.sd-projectgroup{display:flex;align-items:flex-start;gap:var(--sd-2);min-width:0;position:relative}
.sd-projectgroup-ruled::before{content:'';position:absolute;left:6px;right:2px;top:-2px;height:1px;border-radius:1px;background:linear-gradient(90deg,var(--sd-border-strong),var(--sd-border) 70%,var(--sd-border));pointer-events:none}
.sd-projectgroup-ruled::after{content:'';position:absolute;left:6px;top:-2px;width:12px;height:1px;border-radius:1px;background:var(--sd-border-strong);transform-origin:0 0;transform:rotate(121deg);pointer-events:none}
.sd-projectgroup-ruled .sd-projectgroup-rail::before{content:'';position:absolute;left:0;top:6px;width:1px;height:5px;border-radius:1px;background:var(--sd-border-strong);pointer-events:none}
.sd-projectgroup-rail{flex:0 0 20px;width:20px;display:flex;justify-content:center;align-items:flex-start;padding-top:1px;align-self:stretch;position:relative}
.sd-projectgroup-rail-end{flex:0 0 18px;width:18px;padding-top:0;align-items:flex-end}
.sd-root .sd-projectgroup-resize{position:relative;z-index:1;flex:0 0 22px;width:18px;height:22px;padding:0!important;border:0!important;border-radius:4px;background:transparent!important;color:var(--sd-muted);font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:ns-resize;touch-action:none;user-select:none}
.sd-root .sd-projectgroup-resize:hover:not(:disabled){border:0!important;background:color-mix(in srgb, var(--sd-accent) 10%, transparent)!important;color:var(--sd-text)}
.sd-root .sd-projectgroup-resize:focus-visible{outline:2px solid var(--sd-accent);outline-offset:1px}

.sd-projectgroup-cards{flex:1 1 auto;display:flex;gap:var(--sd-2);align-items:flex-start;min-width:0}
.sd-root .sd-projectgroup-toggle{position:relative;z-index:1;align-self:flex-start;width:18px;min-width:18px;min-height:20px;padding:0!important;border:0!important;border-radius:4px;background:transparent!important;color:var(--sd-muted);font-size:11px;line-height:1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.sd-root .sd-projectgroup-toggle:hover:not(:disabled){border:0!important;background:transparent!important;color:var(--sd-text)}
.sd-root .sd-projectgroup-toggle:focus-visible{outline:2px solid var(--sd-accent);outline-offset:1px}
.sd-projectgroup-caret{display:inline-block;transition:transform .12s ease}
.sd-projectgroup-toggle[aria-expanded=true] .sd-projectgroup-caret{transform:rotate(90deg)}
.sd-root .sd-projectgrip{flex:none;width:14px;min-width:14px;min-height:24px;padding:0!important;border:1px solid transparent;border-radius:4px;background:transparent!important;color:var(--sd-faint);font-size:11px;line-height:1;letter-spacing:-1px;cursor:grab;touch-action:none}
.sd-root .sd-projectgrip:hover:not(:disabled),.sd-root .sd-projectgrip:focus-visible{background:var(--sd-surface)!important;border-color:var(--sd-border)!important;color:var(--sd-text)}
.sd-projectcard[data-dragging=true]{opacity:.55}
.sd-projectcancel{position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:50;width:152px;display:flex;flex-direction:column;align-items:center;gap:6px;padding:var(--sd-3);border:1.5px dashed var(--sd-border-strong);border-radius:var(--sd-radius);background:var(--sd-elevated);color:var(--sd-muted);font-size:12px;line-height:1.4;text-align:center;pointer-events:none;box-shadow:var(--sd-shadow-2)}
.sd-projectcancel[data-active=true]{border-color:var(--sd-danger);color:var(--sd-danger);background:#c0392b12}
.sd-projectcancel-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid currentColor;border-radius:999px;font-size:14px;line-height:1}
.sd-projectdragchip{position:fixed;z-index:60;max-width:220px;padding:4px 9px;border:1px solid var(--sd-border);border-radius:999px;background:var(--sd-elevated);color:var(--sd-text);font-size:12px;box-shadow:var(--sd-shadow-2);pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-projectdragchip[data-cancel=true]{border-color:var(--sd-danger);color:var(--sd-danger)}
.sd-projectcard{
  display:flex;flex-direction:column;gap:0;padding:6px 0;
  border:1px solid var(--sd-border);border-radius:var(--sd-radius-sm);background:var(--sd-elevated);
  flex:0 0 340px;width:340px;min-width:0;overflow-wrap:anywhere;position:relative;
  transition:background .14s ease,border-color .14s ease;
}
.sd-projectcard:hover{border-color:var(--sd-border-strong)}
.sd-projectcard[data-expanded=true]{border-color:var(--sd-accent)}
.sd-projectcard[data-over=true]{border-color:var(--sd-accent);background:var(--sd-accent-soft)}
.sd-projectcard-head{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0;padding:0 var(--sd-2)}
.sd-projectcard-head h3{flex:1 1 auto;min-width:0;font-size:13.5px}
.sd-projectstats{display:flex;align-items:center;gap:5px;flex:none;white-space:nowrap;font-size:10.8px;color:var(--sd-muted);font-variant-numeric:tabular-nums;margin:0}
.sd-projectstats b{color:var(--sd-text);font-weight:600}
.sd-projectstats b+b:before{content:'·';margin-right:5px;color:var(--sd-faint)}
.sd-root .sd-ghostcard{flex:0 0 340px;width:340px;display:flex;flex-direction:row;align-items:flex-start;justify-content:flex-start;text-align:left;gap:6px;min-height:0;align-self:stretch;border:1px dashed var(--sd-border-strong);background:transparent;color:var(--sd-muted);cursor:pointer;padding:10px 12px;border-radius:var(--sd-radius-sm);transition:background .14s ease,color .14s ease,border-color .14s ease}
.sd-root .sd-ghostcard:hover:not(:disabled){border-color:var(--sd-accent);background:var(--sd-accent-soft);color:var(--sd-accent-ink)}
.sd-root .sd-ghostcard[data-expanded=true]{min-height:350px}
.sd-ghostcard .sd-plus{font-size:17px;line-height:1;font-weight:400}
/* the project name row is the disclosure; the fixed-width tile keeps its summary visible */
.sd-root .sd-projecttoggle{display:flex;align-items:center;justify-content:flex-start;gap:6px;width:100%;min-height:0;padding:1px 3px;margin-left:-3px;border:1px solid transparent;border-radius:var(--sd-radius-sm);background:transparent;color:var(--sd-text);font-weight:620;text-align:left;min-width:0}
.sd-root .sd-projecttoggle:hover:not(:disabled){background:var(--sd-surface);border-color:var(--sd-border);color:var(--sd-accent-ink)}
.sd-projectname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-projecttoggle-caret{display:inline-flex;align-items:center;justify-content:center;width:10px;height:10px;flex:none;color:var(--sd-faint);transition:transform .12s ease}
.sd-projecttoggle[aria-expanded=true] .sd-projecttoggle-caret{transform:rotate(90deg)}
/* sessions area: same width as its project tile, a fixed height, and internal scrolling.
   It is the deliberately frameless part of the dropdown; the tile border frames it. */
.sd-projectdrop{margin-top:6px;height:var(--sd-row-drop-height,300px);min-width:0;display:flex;flex-direction:column;background:var(--sd-surface);border-radius:var(--sd-radius-sm);overflow:hidden}
.sd-projectdrop:focus-visible{outline:none}
.sd-projectdrop-list{flex:1 1 auto;min-height:0;overflow:auto;padding:2px;display:flex;flex-direction:column;gap:2px;overscroll-behavior:auto}
.sd-projectdrop-empty{margin:auto;padding:var(--sd-2);text-align:center}
.sd-projectdrop-foot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 6px 5px;min-width:0;font-size:11px}
.sd-root .sd-projectdrop-foot button{min-height:24px;padding:0 6px;border-color:transparent;background:transparent;color:var(--sd-muted);font-size:11px}
.sd-root .sd-projectdrop-foot button:hover:not(:disabled){background:var(--sd-elevated);color:var(--sd-text);border-color:transparent}
.sd-projectdrop-tags{flex:1 1 auto;min-width:0;gap:4px;overflow:hidden}
.sd-projectdrop-tags .sd-taggroup{display:flex;flex-direction:column;gap:4px}
.sd-taggroup>.sd-small{font-weight:560}
.sd-tagchoice{min-height:24px;padding:0 8px;border-radius:99px;border:1px solid var(--sd-border-strong);background:var(--sd-bg);color:var(--sd-muted);font-size:11.5px}
.sd-tagchoice[data-selected=true]{border-color:var(--sd-accent);background:var(--sd-accent-soft);color:var(--sd-accent-ink);font-weight:600}
.sd-tagchoice:hover:not(:disabled){color:var(--sd-text)}
.sd-tag{max-width:96px;font-size:10px;padding:0 6px}
.sd-projectrow{display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:var(--sd-radius-sm);background:transparent}
.sd-projectrow+.sd-projectrow{border-top:1px solid var(--sd-border)}
.sd-projectrow:hover{background:var(--sd-elevated)}
.sd-root .sd-rowhead{display:flex;align-items:flex-start;gap:4px;min-width:0}
.sd-rowhead>.sd-projectrow-title,.sd-rowhead>.sd-list-title{flex:1 1 auto;min-width:0}
.sd-rowhead>.sd-popwrap{flex:none;margin-left:auto}
.sd-root .sd-rowhead>.sd-rowgrip{flex:none;height:20px;min-height:20px;margin-top:1px;align-self:flex-start}
.sd-rowedit{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0}
.sd-rowedit input{min-width:0;flex:1 1 auto;font-size:12px;padding:2px 6px}
.sd-rowconfirm{display:flex;flex-direction:column;gap:4px;flex:1 1 100%;margin-top:4px;padding:6px;border:1px dashed var(--sd-border-strong);border-radius:var(--sd-radius-sm)}
.sd-rowconfirm p{margin:0}
.sd-rowhead>.sd-error{flex:1 1 100%;margin:2px 0 0;color:var(--sd-danger)}
.sd-projectrow-title{border:0;background:transparent;padding:0;min-height:0;text-align:left;font-weight:600;font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;justify-content:flex-start;white-space:normal}
.sd-root .sd-projectrow-title:hover:not(:disabled){background:transparent;border:0;color:var(--sd-accent-ink)}
.sd-projectrow-progress{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.sd-statewrap{position:relative;display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%}
.sd-statewrap[data-busy=true]{opacity:.6;cursor:progress}
/* The trigger is a button so the picker can be a real listbox, but it keeps the
   chip face: colour dot, status name, small caret. It ellipsizes before the dot. */
.sd-root button.sd-state-trigger{position:relative;display:inline-flex;align-items:center;justify-content:flex-start;gap:5px;min-height:0;height:auto;padding:1px 14px 1px 6px;border:0;border-radius:99px;background:transparent;box-shadow:none;max-width:150px;min-width:0;overflow:hidden;text-align:left;line-height:1.5;color:var(--sd-chip-color,var(--sd-muted))}
.sd-root button.sd-state-trigger:hover:not(:disabled){background:var(--sd-elevated);border:0}
.sd-root button.sd-state-trigger:disabled{cursor:progress}
.sd-state-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-statecaret{position:absolute;right:3px;top:50%;transform:translateY(-50%);font-size:8px;line-height:1;color:var(--sd-faint);pointer-events:none}
.sd-root .sd-projectrow .sd-statewrap{max-width:128px;min-width:0;overflow:hidden}
.sd-root .sd-projectrow .sd-state-trigger{width:auto;max-width:128px;padding:1px 12px 1px 3px;gap:3px}
.sd-root .sd-projectrow .sd-attentionlabel{display:none}
/* Portal panel: fixed to the viewport so no clipped/auto-overflow ancestor can cut it. */
.sd-statepanel{box-sizing:border-box;color:var(--sd-text);background:var(--sd-surface);border:1px solid var(--sd-border-strong);border-radius:var(--sd-radius-sm);box-shadow:var(--sd-shadow-2);padding:3px;overflow:auto;display:flex;flex-direction:column;gap:1px;outline:none}
.sd-stateoption{display:flex;align-items:center;gap:6px;padding:3px 7px;border-radius:4px;font-size:11.5px;color:var(--sd-text);cursor:pointer;min-height:22px;flex:none}
.sd-stateoption:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--sd-chip-color,var(--sd-faint));flex:none}
.sd-stateoption[data-active=true]{background:var(--sd-accent-soft)}
.sd-stateoption[data-checked=true]{font-weight:620;color:var(--sd-accent-ink)}
.sd-stateoption-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-stateoption-check{flex:none;width:10px;font-size:10px;color:var(--sd-accent-ink)}
/* The derived attention layer is a separate mark beside the status, never a substitute. */
.sd-attentionmark{display:inline-flex;align-items:center;gap:3px;flex:none;color:var(--sd-danger);font-size:10px;font-weight:620;white-space:nowrap}
.sd-attentionmark:before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.sd-attentionmark[data-tone=warn]{color:var(--sd-warn)}
.sd-attentionmark[data-tone=danger]{color:var(--sd-danger)}
.sd-attentioninline{display:inline-flex;align-items:center;gap:4px;flex:none;max-width:100%;overflow:hidden;color:var(--sd-danger);font-size:10px;font-weight:620;white-space:nowrap;text-overflow:ellipsis}
.sd-attentioninline:before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.sd-attentioninline[data-tone=warn]{color:var(--sd-warn)}
.sd-attentioninline[data-tone=danger]{color:var(--sd-danger)}
.sd-elapsed{font-variant-numeric:tabular-nums}
/* Row facets: one count chip per declared fact (running subagents, open todos).
   The strip owns spacing and wrapping; a contribution only declares a chip. */
.sd-facets{display:inline-flex;align-items:center;gap:4px;min-width:0;flex-wrap:wrap}
/* A registered slot with no contributions still renders a node, so emptiness is
   decided by the DOM: a strip without a chip is not a flex item. Without :has the
   rule is dropped and only an inert empty span remains. */
.sd-facets:not(:has(.sd-facet)){display:none}
.sd-facet-wrap{position:relative;display:inline-flex;min-width:0}
.sd-facet{display:inline-flex;align-items:center;gap:3px;height:16px;padding:0 6px;border:1px solid transparent;border-radius:99px;background:var(--sd-surface);color:var(--sd-muted);font:inherit;font-size:10px;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums;cursor:default}
button.sd-facet{cursor:pointer}
button.sd-facet:hover:not(:disabled){border-color:var(--sd-border-strong);color:var(--sd-text)}
button.sd-facet[data-open=true]{border-color:var(--sd-accent);color:var(--sd-accent-ink);background:var(--sd-accent-soft)}
.sd-facet:focus-visible{outline:2px solid var(--sd-accent);outline-offset:1px}
.sd-facet-icon{font-size:9.5px;line-height:1;opacity:.85}
.sd-facet-count{font-weight:640;color:var(--sd-text)}
.sd-facet[data-tone=business]{background:var(--sd-accent-soft);color:var(--sd-accent-ink)}
.sd-facet[data-tone=warn]{background:#fff4e2;color:#8a5a00}
.sd-facet[data-tone=ok]{background:#e9f7ee;color:#1c6b39}
.sd-facet[data-tone=danger]{background:#fdeaea;color:#a02020}
.sd-facet-panel{position:fixed;z-index:1700;max-height:min(52vh,380px);overflow:auto;padding:5px;border:1px solid var(--sd-border-strong);border-radius:var(--sd-radius);background:var(--sd-elevated);box-shadow:0 10px 30px #0b0f1a26,var(--sd-shadow-1)}
.sd-facet-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.sd-facet-row{display:flex;align-items:flex-start;gap:6px;padding:3px 5px;border-radius:var(--sd-radius-sm);font-size:11.5px;line-height:1.45;color:var(--sd-text)}
.sd-facet-dot{flex:none;width:6px;height:6px;margin-top:5px;border-radius:50%;background:var(--sd-faint)}
.sd-facet-row[data-state=running] .sd-facet-dot{background:var(--sd-accent)}
.sd-facet-row[data-state=doing] .sd-facet-dot{background:var(--sd-accent)}
.sd-facet-row[data-state=done] .sd-facet-dot{background:#2f9e5f}
.sd-facet-row[data-state=failed] .sd-facet-dot{background:#d0453b}
.sd-facet-row[data-state=pending] .sd-facet-dot{background:transparent;box-shadow:inset 0 0 0 1px var(--sd-border-strong)}
.sd-facet-rowbody{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.sd-facet-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-facet-meta{color:var(--sd-muted);font-size:10.5px}
.sd-facet-children{margin-top:2px;padding-left:10px;border-left:1px solid var(--sd-border)}
.sd-facet-empty{margin:0;padding:6px 8px;color:var(--sd-muted);font-size:11.5px}
/* The extension manager: one row per directory, its declared capabilities and
   the state the loader actually reached. Kept apart from DSH's plugin list. */
.sd-extlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.sd-extrow{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--sd-border);border-radius:var(--sd-radius);background:var(--sd-surface)}
.sd-extrow[data-state=failed],.sd-extrow[data-state=unsupported],.sd-extrow[data-state=unusable]{border-color:#e2b4b0}
.sd-extrow[data-state=disabled]{opacity:.72}
.sd-extrow[data-builtin=true]{border-style:dashed}
.sd-exthead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
.sd-exthead strong{font-size:13.5px}
.sd-extstate{margin-left:auto;font-size:11px;font-weight:600;white-space:nowrap;color:var(--sd-muted)}
.sd-extstate[data-state=mounted]{color:#1c6b39}
.sd-extstate[data-state=failed],.sd-extstate[data-state=unusable],.sd-extstate[data-state=unsupported]{color:#a02020}
.sd-extcaps{gap:4px}
.sd-extcap{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:99px;border:1px solid var(--sd-border-strong);color:var(--sd-muted);font-variant-numeric:tabular-nums}
.sd-extcap[data-required=true]{border-color:var(--sd-accent);color:var(--sd-accent-ink);background:var(--sd-accent-soft)}
.sd-extcap[data-granted=false]{border-style:dashed;opacity:.6;text-decoration:line-through}
.sd-extproblem{margin:0;color:#a02020;overflow-wrap:anywhere}
.sd-extfoot{margin-top:12px;justify-content:space-between}
.sd-notice{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid #e2b4b0;border-radius:var(--sd-radius-sm);background:#fdf1f0}
.sd-notice p{margin:0;flex:1 1 220px;font-size:12px}
.sd-projectrow-pending{border:1px dashed var(--sd-border-strong);background:var(--sd-bg);opacity:.9}
.sd-projectrow-pending .sd-projectrow-title{font-weight:500;color:var(--sd-muted);cursor:default}
.sd-projectrow-pending::after{content:'';width:10px;height:10px;border:1.5px solid var(--sd-border-strong);border-top-color:var(--sd-accent);border-radius:50%;animation:sd-spin .8s linear infinite;align-self:flex-end;margin-top:-14px}
@keyframes sd-spin{to{transform:rotate(360deg)}}

/* ---- board: columns flow horizontally and share the width that is available ---- */
/* Built-in column heads use the same tone map as the status chip and dropdown. */
.sd-badge{display:inline-flex;align-items:center;justify-content:center;background:var(--sd-elevated);border:1px solid var(--sd-border);border-radius:99px;font-size:10.5px;font-weight:600;min-width:20px;height:19px;padding:0 6px;color:var(--sd-muted);font-variant-numeric:tabular-nums}

/* cards */
.sd-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:540;padding:1px 7px 1px 6px;border-radius:99px;background:transparent;color:var(--sd-chip-color,var(--sd-muted))}
.sd-spinner{display:inline-block;width:9px;height:9px;margin-inline-end:5px;border:1.5px solid color-mix(in srgb, var(--sd-accent) 28%, transparent);border-top-color:var(--sd-accent);border-radius:50%;animation:sd-spin .8s linear infinite;vertical-align:-1px}
/* The project-overview status counter: every project-managed session, in status order. */
.sd-overviewhead{align-items:flex-start;flex-wrap:wrap;gap:var(--sd-2)}
.sd-projecthint{margin:0}
.sd-statuscounts{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:4px;min-width:0;max-width:60%}
/* A chip is a real toggle button: the active status stays visibly pressed and a
   second press removes its filter. These rules override the dashboard's default
   button face so the pill keeps its old look and right-aligned wrap. */
.sd-root button.sd-statuscount{display:inline-flex;align-items:center;gap:4px;min-height:0;height:auto;padding:1px 7px;border:1px solid var(--sd-border);border-radius:99px;background:var(--sd-surface);font-size:10.5px;font-weight:400;line-height:1.5;color:var(--sd-chip-color,var(--sd-muted));white-space:nowrap}
.sd-root button.sd-statuscount:hover:not(:disabled){border-color:var(--sd-border-strong);background:var(--sd-surface-2);color:var(--sd-chip-color,var(--sd-muted))}
.sd-root button.sd-statuscount:active:not(:disabled){background:var(--sd-surface-2)}
.sd-root button.sd-statuscount:focus-visible{outline:2px solid var(--sd-accent);outline-offset:2px}
.sd-root button.sd-statuscount[aria-pressed=true]{border-color:var(--sd-chip-color,var(--sd-accent));background:var(--sd-accent-soft);color:var(--sd-chip-color,var(--sd-accent));box-shadow:inset 0 0 0 1px var(--sd-chip-color,var(--sd-accent))}
.sd-root button.sd-statuscount[aria-pressed=true]:hover:not(:disabled){border-color:var(--sd-chip-color,var(--sd-accent));background:var(--sd-accent-soft);color:var(--sd-chip-color,var(--sd-accent));box-shadow:inset 0 0 0 1px var(--sd-chip-color,var(--sd-accent))}
.sd-statuscount:before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;flex:none;opacity:.85}
.sd-statuscount b{font-weight:620;font-variant-numeric:tabular-nums;color:var(--sd-text)}
/* The top-right filter selector: one facet row per dimension, chips wrap inside
   the panel and the trigger only reports how many values are active. */
.sd-filtertrigger{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border:1px solid var(--sd-border);border-radius:99px;background:var(--sd-surface);color:var(--sd-muted)}
.sd-root .sd-filtertrigger:hover:not(:disabled){border-color:var(--sd-border-strong);color:var(--sd-text)}
.sd-root .sd-filtertrigger[aria-expanded=true]{border-color:var(--sd-accent);background:var(--sd-accent-soft);color:var(--sd-accent)}
.sd-filtercount{display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 3px;border-radius:99px;background:var(--sd-accent);color:var(--sd-accent-ink);font-size:9.5px;font-weight:650;font-variant-numeric:tabular-nums}
.sd-filterpanel{width:min(560px,calc(100vw - 24px));max-height:min(72vh,560px);overflow:auto;gap:var(--sd-2)}
.sd-filterpanel .sd-statuscounts{max-width:100%;justify-content:flex-start}
.sd-filterrow{display:flex;flex-direction:column;gap:4px;padding-bottom:6px;border-bottom:1px solid var(--sd-border)}
.sd-filterrow:last-of-type{border-bottom:0}
.sd-filterrow h4{margin:0;font-size:10.5px;font-weight:600;letter-spacing:.02em;color:var(--sd-faint)}
/* The board bar replaces the old title row: a dimension picker plus the filter
   categories, spread across the page instead of hidden behind one popover. */
.sd-boardbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;width:100%;padding:0 0 6px;border-bottom:1px solid var(--sd-border)}
.sd-dimension{display:flex;align-items:center;gap:6px;min-width:0}
.sd-root button.sd-dimensiontrigger{display:inline-flex;align-items:center;gap:6px;min-height:0;height:auto;padding:2px 8px;border:1px solid var(--sd-border);border-radius:99px;background:var(--sd-surface);font-size:12px;color:var(--sd-text)}
.sd-root button.sd-dimensiontrigger:hover:not(:disabled){border-color:var(--sd-border-strong);background:var(--sd-surface-2)}
.sd-dimensioncaret{flex:none;color:var(--sd-faint);transform:rotate(90deg)}
.sd-dimensioncheck{margin-left:4px;color:var(--sd-accent)}
.sd-filterbar{display:contents}
.sd-filterbar .sd-filtermeta{order:1;flex:0 1 auto;margin:0 0 0 auto}
.sd-filtercats{order:3;flex:1 1 100%;display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px 16px;min-width:0}
.sd-filtercat{order:3;display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;max-width:100%}
.sd-root button.sd-filtercat-head{display:inline-flex;align-items:center;justify-content:flex-start;text-align:left;gap:6px;min-height:0;height:auto;padding:1px 3px;border:1px solid transparent;border-radius:var(--sd-radius-sm);background:transparent;font-size:11px;font-weight:600;color:var(--sd-faint)}
.sd-root button.sd-filtercat-head:hover:not(:disabled){background:var(--sd-surface);color:var(--sd-text)}
.sd-filtercat-caret{flex:none;color:var(--sd-faint);transition:transform .12s ease}
.sd-filtercat[data-open=true] .sd-filtercat-caret{transform:rotate(90deg)}
.sd-filtercat-name{color:var(--sd-text)}
.sd-filtervalues{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0;max-width:100%}
.sd-filterfoot{order:2;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sd-valuegrid{display:flex;flex-wrap:wrap;gap:var(--sd-3);min-width:0}
.sd-valuecard .sd-projectdrop{height:auto;max-height:var(--sd-row-drop-height,300px)}
.sd-filtermeta{margin:0}
.sd-root button.sd-statuscount:disabled{opacity:.45;cursor:default}
.sd-status:before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;flex:none;opacity:.85}
.sd-tag{padding:1px 7px;border:1px solid var(--sd-border);border-radius:99px;background:var(--sd-surface);font-size:10.5px;color:var(--sd-muted);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-runtime{font-size:10.8px;color:var(--sd-faint)}
.sd-runtime[data-warning=true]{color:var(--sd-warn)}
.sd-root [data-host-archive=archived]{border-style:dashed}
.sd-root [data-host-archive=unknown],.sd-root [data-host-archive=unsupported]{border-style:dashed;border-color:var(--sd-warn)}
/* wider columns carry more of the same card instead of new boxes */


/* list views */

/* ---- overlays ---- */
.sd-overlay[hidden]{display:none}
.sd-overlay[data-preview-cache][hidden]{display:block!important;visibility:hidden;pointer-events:none;z-index:-1}
.sd-overlay{position:absolute;inset:0;background:#0b0f1a5c;z-index:20;display:flex;align-items:center;justify-content:center;padding:var(--sd-4);backdrop-filter:blur(1.5px)}
.sd-modal[data-wide=true]{width:min(1000px,100%)}
.sd-modal{background:var(--sd-elevated,var(--dsw-alias-bg-base,#fff));border:1px solid var(--sd-border);border-radius:var(--sd-radius-lg);padding:var(--sd-5);width:min(600px,100%);max-height:92%;display:flex;flex-direction:column;gap:var(--sd-4);box-shadow:0 24px 80px #0b0f1a3d;overflow:auto;overflow-wrap:anywhere}
.sd-modal-head{display:flex;justify-content:space-between;align-items:center;gap:var(--sd-3)}
.sd-modal-head h2{font-size:16px}
.sd-modal-head[data-sticky=true]{position:sticky;top:0;z-index:3;background:var(--sd-elevated);border-bottom:1px solid var(--sd-border);padding-bottom:var(--sd-3)}
.sd-modal-foot{display:flex;justify-content:flex-end;gap:var(--sd-2);flex-wrap:wrap;margin-top:var(--sd-1);padding-top:var(--sd-3);border-top:1px solid var(--sd-border)}
.sd-modal-foot button{background:var(--sd-surface)}
.sd-modal-foot .sd-primary{background:var(--sd-accent)}
.sd-drawer-overlay{z-index:15;justify-content:flex-end;padding:0;background:#0b0f1a3d;backdrop-filter:none}
.sd-drawer{height:100%;max-height:100%;width:min(540px,100%);border-radius:0;border-right:0;padding:var(--sd-4) var(--sd-5);gap:var(--sd-3)}

/* ---- read-only conversation preview ---- */
.sd-native-page-wrap{position:relative;min-height:0;height:min(74vh,680px);border:1px solid var(--sd-border);border-radius:var(--sd-radius);overflow:hidden;background:var(--sd-bg)}
.sd-native-page{display:block;width:100%;height:100%;border:0;background:var(--sd-bg)}
.sd-native-page-wrap>.sd-transcript-state{position:absolute;inset:0;display:grid;place-items:center;margin:0;pointer-events:none;background:var(--sd-bg)}
.sd-native-page-wrap[data-preview-pending] .sd-native-page{visibility:hidden}
.sd-preview-deck{display:flex;align-items:stretch;justify-content:center;gap:12px;width:max-content;max-width:100%;min-height:0}
.sd-preview-pane{flex:0 1 auto;width:1000px;min-width:0;max-width:min(1000px,100%);display:flex;flex-direction:column;gap:8px;padding:var(--sd-4);border:1px solid var(--sd-border);border-radius:var(--sd-radius-lg);background:var(--sd-elevated);box-shadow:0 24px 80px #0b0f1a3d;max-height:92%;overflow:auto}
@media (max-width:1100px){.sd-preview-deck{flex-direction:column;align-items:center}}
.sd-preview-pane-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0;flex-wrap:wrap}
.sd-preview-pane-head h2{flex:1 1 220px;font-size:15px;font-weight:600;margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-preview-pane-head>.sd-row{flex:0 1 auto;min-width:0;justify-content:flex-end;row-gap:4px}
.sd-preview-pane-head .sd-statewrap{max-width:150px;min-width:0;overflow:hidden}
.sd-preview-pane-hint{margin:0}
/* Expanded preview: the frame takes the overlay's content box, leaving only a
   small gutter and the window head. The full-screen toggle lives in that head,
   above the frame, so it never covers the native page's own controls. */
.sd-preview-deck[data-expanded=true]{width:100%;max-width:none;height:100%;min-height:0}
.sd-preview-pane[data-expanded=true]{flex:1 1 auto;width:100%;max-width:none;height:100%;max-height:100%;padding:8px;gap:6px}
.sd-preview-pane[data-expanded=true] .sd-preview-pane-hint{display:none}
.sd-preview-pane[data-expanded=true] .sd-native-page-wrap{flex:1 1 auto;height:auto;min-height:0}
/* Pick mode hides the deck and shows this bar: it is a lightweight prompt on top
   of the interactive dashboard, not a modal, so any session row stays clickable. */
.sd-split-pickbar{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1500;display:flex;flex-direction:row;align-items:center;height:auto;gap:var(--sd-3);max-width:calc(100% - 24px);padding:var(--sd-2) var(--sd-3);border:1px solid var(--sd-border-strong);border-radius:var(--sd-radius-lg);background:var(--sd-elevated);box-shadow:0 12px 40px #0b0f1a3d}
.sd-split-pickbar p{margin:0;font-size:12.5px}
.sd-split-pickbar button{flex:none}
/* The enter action is a real link so the browser opens a native tab. It borrows the
   bordered .sd-small button look instead of the document's underlined anchor. */
.sd-root a.sd-preview-enter{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:0 10px;border:1px solid var(--sd-border);border-radius:var(--sd-radius-sm);background:var(--sd-elevated);color:inherit;text-decoration:none;transition:background .12s ease,border-color .12s ease,color .12s ease,box-shadow .12s ease}
.sd-root a.sd-preview-enter:hover{background:var(--sd-surface);border-color:var(--sd-border-strong)}
.sd-root a.sd-preview-enter:focus-visible{outline:2px solid var(--sd-accent);outline-offset:2px}
.sd-transcript-state{margin:var(--sd-4) 0;text-align:center;color:var(--sd-muted)}

/* ---- forms ---- */
.sd-formfield{display:flex;flex-direction:column;gap:5px;min-width:0}
.sd-formfield>span{font-weight:600;font-size:12px}
.sd-formfield>small{color:var(--sd-faint);font-size:11px}
.sd-check{display:flex;gap:var(--sd-2);align-items:flex-start;font-size:12px;line-height:1.5}
.sd-check input{margin-top:2px}
.sd-draftbar{padding:var(--sd-2) var(--sd-3);border:1px dashed var(--sd-border-strong);background:var(--sd-surface);border-radius:var(--sd-radius);display:flex;align-items:center;justify-content:space-between;gap:var(--sd-3);flex-wrap:wrap;font-size:12px}
.sd-divider{border:0;border-top:1px solid var(--sd-border);width:100%;margin:var(--sd-1) 0}
.sd-collapsible-head{display:flex;align-items:center;gap:var(--sd-2);width:100%;padding:var(--sd-2) 0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sd-collapsible-caret{display:inline-block;transition:transform .12s ease}
.sd-collapsible-head[aria-expanded=true] .sd-collapsible-caret{transform:rotate(90deg)}
.sd-orderrow{display:flex;align-items:center;justify-content:space-between;gap:var(--sd-2);padding:var(--sd-1) var(--sd-2);border:1px solid var(--sd-border);border-radius:var(--sd-radius-sm);background:var(--sd-elevated)}
.sd-orderrow:hover{border-color:var(--sd-border-strong)}
.sd-orderrow[draggable=true]{cursor:grab}
.sd-root .sd-orderrow button{padding:0 var(--sd-2);min-height:26px;font-size:11.5px}
/* colour field: native palette + hex value + presets */
.sd-colorfield{display:flex;flex-direction:column;gap:6px;min-width:0}
.sd-colorlabel{font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px}
.sd-colorlabel small{font-weight:400;color:var(--sd-faint);font-size:11px}
.sd-colorrow{display:flex;align-items:center;gap:var(--sd-2);flex-wrap:wrap}
.sd-color{width:36px;height:30px;padding:2px;border:1px solid var(--sd-border);border-radius:var(--sd-radius-sm);background:var(--sd-elevated);cursor:pointer;flex:none}
.sd-colorhex{width:116px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.sd-swatches{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:22px}
.sd-root .sd-swatch{width:22px;min-width:22px;height:22px;min-height:22px;padding:0;border-radius:50%;border:1px solid #0000001f;box-shadow:inset 0 0 0 1px #ffffff40;cursor:pointer}
.sd-root .sd-swatch:hover:not(:disabled){border-color:var(--sd-text)}
.sd-root .sd-swatch[aria-pressed=true]{outline:2px solid var(--sd-accent);outline-offset:1px}
.sd-history{padding:var(--sd-2) var(--sd-3);border:1px solid var(--sd-border);border-radius:var(--sd-radius-sm);background:var(--sd-surface);overflow-wrap:anywhere;font-size:11.5px;color:var(--sd-muted)}
.sd-root [hidden]{display:none!important}
.sd-empty,.sd-col-empty,.sd-summary,.sd-card-meta,.sd-projectstats{font-variant-numeric:tabular-nums}

/* ---- dark ---- */
body[data-ds-dark-theme] .sd-root{
  color-scheme:dark;
  --sd-bg:var(--dsw-alias-bg-base,#16181d);
  --sd-surface:var(--dsw-alias-bg-layer-1,#1e2128);
  --sd-surface-2:#262b34;
  --sd-elevated:#1b1e25;
  --sd-border:var(--dsw-alias-border-l3,#313743);
  --sd-border-strong:#3f4654;
  --sd-text:var(--dsw-alias-label-primary,#e8ebf1);
  --sd-muted:var(--dsw-alias-label-secondary,#a2abb9);
  --sd-faint:#9aa5b5;
  --sd-accent:var(--dsw-alias-brand-primary,#7b89dd);
  --sd-accent-soft:#7b89dd1f;
  --sd-accent-ink:#aab4f2;
  --sd-on-accent:var(--dsw-alias-label-primary-foreground,#12141a);
  --sd-info:#7aa2e0;--sd-warn:#d3a45a;--sd-ok:#63b48b;--sd-danger:#e08375;
  --sd-shadow-1:0 1px 2px #0006,0 1px 3px #0004;
  --sd-shadow-2:0 8px 22px #0008,0 20px 44px #0007;
}

/* ---- responsive ---- */
@media(max-width:900px){
  .sd-head{padding:var(--sd-3) var(--sd-3) 0}
  .sd-toolbar{padding:var(--sd-2) var(--sd-3)}
  .sd-scroll{padding:var(--sd-2) var(--sd-3) var(--sd-5)}
  .sd-toasts{right:12px;top:8px;width:min(360px,calc(100vw - 16px))}}
@media(max-width:760px){
  .sd-root h1{font-size:19px}
  .sd-overviewhead{flex-direction:column;align-items:stretch}
  .sd-statuscounts{max-width:100%;justify-content:flex-start}
  .sd-titlebar{flex-direction:column;align-items:stretch}
  .sd-actions{justify-content:flex-end}
  .sd-projectcard,.sd-root .sd-ghostcard{flex:1 1 100%;width:auto}
  .sd-overlay[hidden]{display:none}
.sd-overlay[data-preview-cache][hidden]{display:block!important;visibility:hidden;pointer-events:none;z-index:-1}
.sd-overlay{padding:var(--sd-2)}
  .sd-drawer-overlay{padding:0}}
.sd-root.sd-overlay-root{position:fixed;inset:0;z-index:1200;height:100%;background:transparent;pointer-events:none}
.sd-overlay-root>.sd-overlay[hidden]{display:none}
.sd-overlay[data-preview-cache][hidden]{display:block!important;visibility:hidden;pointer-events:none;z-index:-1}
.sd-overlay{position:absolute;inset:0;pointer-events:auto}
[data-platform=darwin] .sd-head{padding-top:calc(var(--sd-4) + var(--dsh-frame-top-clearance,0px))}
html[data-session-dashboard-exclude] [data-row-key^="session:"][data-session-dashboard-member="true"]{display:none!important}
button[data-session-dashboard-filter][aria-pressed="true"]{color:var(--dsw-alias-state-business-primary,var(--sd-accent))}
.sd-panel-icon{position:relative;display:inline-flex;align-items:center;justify-content:center}
.sd-panel-dot{position:absolute;right:-3px;bottom:-2px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#21a366);box-shadow:0 0 0 2px var(--dsw-specific-sidebar-fill,var(--sd-bg));pointer-events:none}
.sd-completion-stack{position:fixed;right:20px;bottom:20px;z-index:80;display:flex;flex-direction:column-reverse;align-items:flex-end;gap:10px;max-height:calc(100vh - 40px);overflow-y:auto;pointer-events:none;padding:2px}
.sd-completion-toast{position:relative;display:flex;flex-direction:column;height:auto;min-height:0;align-items:stretch;gap:0;width:min(440px,calc(100vw - 40px));padding:0;border:1px solid color-mix(in srgb, var(--sd-accent) 38%, var(--sd-border));border-radius:var(--sd-radius);background:color-mix(in srgb, var(--sd-accent) 18%, var(--sd-bg));box-shadow:0 10px 32px #00000026;font-size:13px;pointer-events:auto;overflow:hidden}
.sd-completion-toast[data-cancelled=true] .sd-completion-track{display:none}
.sd-completion-head{display:flex;align-items:center;gap:6px;padding:7px 12px;background:var(--sd-accent);color:var(--sd-on-accent);font-size:12px;font-weight:650}
.sd-completion-head strong{color:inherit;font-size:12px;font-weight:inherit}
.sd-completion-mark{font-size:10px;line-height:1;opacity:.85}
.sd-completion-body{display:flex;align-items:flex-start;gap:12px;padding:10px 12px 12px;background:color-mix(in srgb, var(--sd-accent) 12%, transparent)}
.sd-completion-copy{min-width:0;flex:1}.sd-completion-copy p{margin:0;overflow-wrap:anywhere;line-height:1.45}.sd-completion-toast .sd-row{flex:none;align-items:center;pointer-events:auto}
.sd-completion-track{position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--sd-accent-soft);pointer-events:none}
.sd-completion-progress{display:block;height:100%;background:var(--sd-accent);transform-origin:left center;animation:sd-completion-countdown linear forwards}
@keyframes sd-completion-countdown{from{transform:scaleX(1)}to{transform:scaleX(0)}}`

