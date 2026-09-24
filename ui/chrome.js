'use strict';
(()=>{
 const header=document.querySelector('.window-bar'),controls=document.createElement('div');controls.className='window-controls';
 controls.innerHTML='<button type="button" data-window="minimize" aria-label="最小化"><span class="window-min"></span></button><button type="button" data-window="maximize" aria-label="最大化"><span class="window-max"></span></button><button type="button" data-window="close" aria-label="关闭并在后台运行"><span class="window-close">×</span></button>';
 header.append(controls);
 controls.addEventListener('click',async e=>{const action=e.target.closest('button')?.dataset.window;if(action)await window.windowChrome?.call(action)});
 const state=value=>{const b=controls.querySelector('[data-window=maximize]');b.ariaLabel=b.title=value.maximized?'还原窗口':'最大化';b.classList.toggle('restored',value.maximized);document.documentElement.dataset.maximized=String(value.maximized)};
 window.windowChrome?.onState(state);window.windowChrome?.call('state').then(state).catch(()=>{});
 // Controls stay usable above modal dialogs; the title divider belongs to them.
 document.addEventListener('toggle',e=>{if(e.target.tagName!=='DIALOG')return;const modal=[...document.querySelectorAll('dialog[open]')].at(-1);if(controls.matches(':popover-open'))controls.hidePopover();controls.removeAttribute('popover');(modal||header).append(controls);if(modal){controls.setAttribute('popover','manual');controls.showPopover()}},true);
})();
