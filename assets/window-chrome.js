(()=>{
  const controls=document.createElement('div');controls.className='window-controls';
  controls.innerHTML='<button data-action="minimize" aria-label="最小化" title="最小化"><span class="window-min"></span></button><button data-action="maximize" aria-label="最大化" title="最大化"><span class="window-max"></span></button><button data-action="close" aria-label="关闭并在后台运行" title="关闭并在后台运行"><span class="window-close">×</span></button>';
  document.querySelector('header').append(controls);
  controls.addEventListener('click',e=>{const b=e.target.closest('button');if(b)window.windowChrome?.call(b.dataset.action).catch(console.error)});
  const state=s=>{const b=controls.querySelector('[data-action=maximize]');b.title=b.ariaLabel=s.maximized?'还原窗口':'最大化';b.classList.toggle('restored',s.maximized)};
  window.windowChrome?.onState(state);window.windowChrome?.call('state').then(state).catch(()=>{});
  // A modal makes its background inert; keep the same controls in its top layer.
  const modals=[];
  let first=true,pending=0,timer,start;
  const banner=document.createElement('div');banner.className='nas-loading';banner.hidden=true;banner.setAttribute('popover','manual');banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');document.body.append(banner);
  document.addEventListener('toggle',e=>{if(e.target.tagName!=='DIALOG')return;const index=modals.indexOf(e.target);if(index>=0)modals.splice(index,1);if(e.target.open)modals.push(e.target);const modal=modals.filter(d=>d.open).at(-1);
    if(controls.matches(':popover-open'))controls.hidePopover();controls.removeAttribute('popover');(modal||document.querySelector('header')).append(controls);if(modal){controls.setAttribute('popover','manual');controls.showPopover()}
    if(banner.matches(':popover-open'))banner.hidePopover();(modal||document.body).append(banner);if(pending)banner.showPopover();
  },true);
  function paint(){const elapsed=Math.floor((Date.now()-start)/1000);banner.innerHTML='<span class="nas-spinner" aria-hidden="true"></span><div><strong>'+(first?'首次加载 · 正在检索 NAS':'正在刷新需求状态')+'</strong><small>'+(first?'需检索多个状态目录，数据较多，首次加载可能较久，请稍候。':'正在读取最新需求数据，请稍候。')+(elapsed>=5?' 已等待 '+elapsed+' 秒。':'')+'</small></div>';}
  window.trackNas=async(command,work)=>{
    if(!['scan','configure'].includes(command))return work();
    if(pending++===0){start=Date.now();banner.hidden=false;banner.showPopover();paint();timer=setInterval(paint,1000);document.body.classList.add('nas-busy');}
    try{const r=await work();if(r.ok&&r.value?.checkedAt)first=false;return r;}
    finally{if(--pending===0){clearInterval(timer);banner.hidePopover();banner.hidden=true;document.body.classList.remove('nas-busy');}}
  };
})();
