'use strict';
function notificationOptions(task,settings={},icon){return {title:'新任务已分配',body:(task.title||task.product)+' · '+task.items.reduce((sum,i)=>sum+(i.points||0),0)+' 点',icon,silent:settings.mute===true}}
module.exports={notificationOptions};
