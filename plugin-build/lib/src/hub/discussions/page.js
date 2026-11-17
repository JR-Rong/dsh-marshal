import { GROUP_MARKDOWN_CSS, GROUP_MARKDOWN_SCRIPT } from "./markdown.js";
import { PRESETS_CSS, PRESETS_HTML, PRESETS_SCRIPT } from "./presets-page.js";
export const DISCUSSION_CSS = `
/* 旧的 Agent 群聊已下线：群聊统一由本机“调度官”页签负责。 */
#groupMode, #groupWorkspace, .mode-switch { display:none !important; }
.mode-switch { display:flex; gap:6px; }
.mode-switch button[aria-pressed="true"] { background:var(--selected); color:var(--accent); border-color:var(--accent); }
.group-workspace { display:grid; grid-template-columns:240px minmax(0,1fr); flex:1; min-height:0; }
.group-rail { background:var(--rail); border-right:1px solid var(--line); padding:20px 12px; overflow:auto; }
.group-rail > button { width:100%; margin-bottom:18px; }
.group-main { min-height:0; display:flex; flex-direction:column; padding:26px 28px 18px; gap:16px; overflow:auto; }
.group-intro h2,.group-heading h2 { font-size:20px; margin-bottom:6px; }
.group-intro p,.group-heading p,.group-note { color:var(--muted); font-size:12px; line-height:1.7; }
.group-fields { display:grid; gap:12px; max-width:840px; }
.group-fields label { display:grid; gap:6px; }
.group-fields textarea,.group-compose textarea { font:inherit; color:var(--text); background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px; resize:vertical; min-height:90px; width:100%; }
.group-members { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.group-member-choice { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; padding:12px; border:1px solid var(--line); border-radius:10px; background:var(--surface); }
.group-member-choice label { grid-column:1/-1; color:var(--muted); font-size:12px; }
.group-member-choice select { width:100%; }
.group-profile { grid-column:1/-1; padding-top:8px; border-top:1px solid var(--line); }
.group-profile summary { cursor:pointer; color:var(--accent); font-size:12px; }
.group-profile-fields { display:grid; gap:10px; margin-top:10px; }
.group-profile-fields label { display:grid; gap:5px; font-size:12px; color:var(--muted); }
.group-profile-fields textarea { width:100%; min-height:65px; font:inherit; color:var(--text); background:var(--bg); padding:8px; border:1px solid var(--line); border-radius:6px; resize:vertical; }
.group-message.streaming { border-color:var(--accent); }
.group-live { color:var(--accent); font-variant-numeric:tabular-nums; }
.group-settings { padding:16px; margin-top:12px; border:1px solid var(--line); border-radius:10px; }
.group-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.group-preview { border:1px solid var(--accent); padding:18px; border-radius:10px; display:grid; gap:12px; }
.group-preview pre,.group-message p { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; margin:0; }
.group-roster { display:flex; flex-wrap:wrap; gap:8px; }
#groupRoom > .group-actions { margin-top:10px; }
.group-chip { padding:8px 12px; border:1px solid var(--line); border-radius:8px; background:var(--surface); font-size:12px; }
.group-chip strong,.group-chip .group-member-meta,.group-chip .group-member-usage { display:block; }
.group-chip { flex:1 1 220px; min-width:0; overflow-wrap:anywhere; }
.group-member-meta { color:var(--muted); margin-top:5px; line-height:1.5; }
.group-member-usage { margin-top:10px; font-variant-numeric:tabular-nums; }
.group-usage { margin:14px 0; padding:14px 18px; background:var(--selected); border-radius:10px; display:flex; align-items:baseline; flex-wrap:wrap; gap:8px 20px; font-variant-numeric:tabular-nums; }
.group-usage strong { font-size:20px; }
.group-usage small { flex-basis:100%; color:var(--muted); line-height:1.5; }
.group-call-usage { margin-top:12px; padding-top:8px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
.group-chip.running { color:var(--accent); border-color:var(--accent); }
.group-timeline { flex:1; min-height:180px; overflow:auto; display:flex; flex-direction:column; gap:14px; padding:4px 0 12px; }
.group-message { padding:15px 18px; border:1px solid var(--line); border-radius:10px; background:var(--surface); max-width:920px; }
.group-message.user { background:var(--selected); border-color:transparent; }
.group-message header { display:flex; gap:12px; justify-content:space-between; margin-bottom:8px; font-size:12px; color:var(--muted); }
.group-message strong { color:var(--accent); }
.group-message.failed { border-color:var(--danger); }
.group-compose { border-top:1px solid var(--line); padding-top:14px; display:grid; gap:10px; }
.group-compose select { max-width:350px; }
#groupStatus { color:var(--warning); min-height:20px; }
@media(max-width:780px) { .group-workspace { grid-template-columns:170px minmax(0,1fr); } .group-main { padding:18px 14px; } .group-members { grid-template-columns:1fr; } .app-header { flex-wrap:wrap; } }
@media(max-width:520px) { .group-workspace { grid-template-columns:1fr; overflow:auto; } .group-rail { max-height:180px; border-right:0; border-bottom:1px solid var(--line); } .group-main { overflow:visible; } .group-timeline { max-height:55vh; } }
${GROUP_MARKDOWN_CSS}
${PRESETS_CSS}
`;
export const DISCUSSION_HTML = `
<div id="groupWorkspace" class="group-workspace" hidden>
  <nav class="group-rail" aria-label="Agent 群聊"><button id="groupNew" class="primary" type="button">＋ 新建群聊</button><button id="groupPresetLibrary" type="button">Agent 预设库</button><div id="groupList"></div></nav>
  <section class="group-main" aria-label="群聊工作区">
    ${PRESETS_HTML}
    <div id="groupDraft">
      <div class="group-intro"><h2>让 agent 协作完成工作</h2><p>选择 2–4 位成员，并指定主持人。主持人自动分工，成员回复后自动汇总。</p></div>
      <form id="groupCreateForm" class="group-fields">
        <label>协作模式<select id="groupKind" aria-label="协作模式"><option value="work">执行工作 · 修改文件与运行检查</option><option value="discussion">仅讨论 · 分析与建议</option></select></label>
        <label>群聊名称<input id="groupTitle" maxlength="80" placeholder="例如：一起评审部署方案" required></label>
        <div><p class="group-note">成员 · 可跨设备选择</p><div id="groupMembers" class="group-members"></div><button id="groupAddMember" type="button">添加成员</button></div>
        <label>主持 agent<select id="groupModerator" aria-label="主持 agent"><option value="0">成员 1</option><option value="1">成员 2</option></select></label>
        <label>第一条消息<textarea id="groupFirstMessage" maxlength="8192" placeholder="描述目标、需要修改的内容，以及如何验证完成…" required></textarea></label>
        <p class="group-note">执行工作时，主持人分配任务，Codex 成员在你指定的现有项目目录中修改文件、运行命令并汇报结果。每群最多 3 轮；工作群保留 60 分钟，讨论群保留 15 分钟。</p>
        <div class="group-actions"><button class="primary" id="groupPreviewButton">预览并创建</button></div>
      </form>
      <div id="groupPreview" class="group-preview" hidden></div>
    </div>
    <div id="groupRoom" hidden>
      <header class="group-heading"><h2 id="groupRoomTitle"></h2><p id="groupRoomMeta"></p></header>
      <div id="groupUsage" class="group-usage" role="group" aria-label="群聊总用量"></div>
      <div id="groupRoster" class="group-roster"></div>
      <div class="group-actions"><button id="groupEditProfiles" type="button">成员设置</button><button id="groupStop" type="button">停止并结束群聊</button><button id="groupReconcile" type="button">核对运行状态</button></div>
      <form id="groupProfileForm" class="group-settings" hidden><p class="group-note">设置仅用于本群，从下一轮开始生效；不会改变工具与目录权限。</p><div id="groupProfileFields" class="group-members"></div><div class="group-actions"><button class="primary" type="submit">保存成员设置</button><button id="groupProfileCancel" type="button">取消</button></div></form>
    </div>
    <div id="groupTimeline" class="group-timeline" role="log" aria-label="群聊消息" aria-live="polite" hidden></div>
    <form id="groupSendForm" class="group-compose" hidden><textarea id="groupMessage" maxlength="8192" aria-label="群聊消息" placeholder="补充问题，由主持人继续组织讨论…"></textarea><div class="group-actions"><button id="groupSend" class="primary">发送到群聊</button><span class="group-note">发送后由主持人自动分工、收集回复并汇总。</span></div></form>
    <p id="groupStatus" role="status" aria-live="polite"></p>
  </section>
</div>
`;
export const DISCUSSION_SCRIPT = `
${GROUP_MARKDOWN_SCRIPT}
${PRESETS_SCRIPT}
var groupStream = null, groupVisible = false, groupCatalog = [], groupChoices = ['', ''], groupCurrent = null, groupBusy = false, groupFetch = 0;
var groupPreviewData = null, groupWorkspaces = ['', ''], groupReasonings = ['', ''], groupProfiles = [{},{}];
var groupRefreshTimer=null, groupRefreshing=false, groupRefreshDirty=false, groupRenderedRoom=null, groupMessageNodes=new Map(), groupEditing=null;
function groupEffortLabel(value) { return ({off:'关闭',none:'关闭',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高'})[value] || value || '模型默认'; }
function groupNode(id) { return document.getElementById(id); }
function groupStatus(text) { groupNode('groupStatus').textContent = text || ''; }
function groupError(code) {
  return ({'writer-busy':'成员仍在回复，请等待或停止群聊。','revision-conflict':'设备或成员配置已变化，请重新预览。','size-limit':'达到成员、轮次或内容上限，请结束当前群聊后新建。','expired':'本群内容已到期，请新建群聊。','unsupported':'群聊当前不可用。','outcome-unknown':'上次调用结果尚未确认，请先核对运行状态。','idempotency-conflict':'上次提交尚未确认，不能以同一操作替换内容。请先核对运行状态。','auth-required':'成员尚未登录模型服务。','invalid-plan':'主持人的分工格式无效，本轮已停止。可以补充说明后重试。','moderator-failed':'主持人未能完成分工，本轮已停止。','cancelled':'本次发言已停止。','response-incomplete':'模型在完成回复前中断，本次没有重新派发任务。','agent-crashed':'成员调用未完成，请检查模型服务和网络。','invalid-workspace':'执行成员需要选择 Codex，并填写该设备上已存在的项目绝对路径；不能选择用户主目录或凭据目录。','invalid-args':'请检查群聊内容、成员和主持人选择。','isolation-violation':'成员调用无法保持仅讨论模式，已停止。'})[code] || ('操作未完成：' + (code || '连接中断'));
}
async function groupRequest(data, query) {
  var response = await request('/marshal/api/discussions' + (query || ''), data ? {method:'POST',headers:writeHeaders(),body:JSON.stringify(data)} : {method:'GET'});
  if (response.status === 401) { showLogin('会话已失效'); throw new Error('unauthorized'); }
  var body = await response.json(); if (!response.ok) throw new Error(body.code || 'unknown'); return body;
}
function groupKey(scope) {
  var name = 'marshal-group-key:' + origin + ':' + (session && session.operatorId) + ':' + scope;
  var value = localStorage.getItem(name); if (!value) { value = newKey(); localStorage.setItem(name,value); }
  return {key:value,clear:function(){localStorage.removeItem(name);}};
}
async function groupWrite(data, scope) {
  var saved = groupKey(scope); data.key = saved.key;
  var body = await groupRequest(data); saved.clear(); return body;
}

function groupProfileSummary(profile) {
  profile=profile||{};
  return ({general:'通用讲解',professional:'专业实践',expert:'专家深度'}[profile.expertise]||'专业实践')+' · '+({collaborate:'协作推进',challenge:'质疑反驳',review:'独立审查'}[profile.stance]||'协作推进')+(profile.persona?' · '+profile.persona:'');
}
function groupProfileFields(profile, label, changed, withPresets) {
  var root=textNode('div','','group-profile-fields');
  var presets=withPresets===false?null:groupPresetControls(profile,label,function(){changed();root.replaceWith(groupProfileFields(profile,label,changed));});
  if(presets)root.append(presets.root);
  function edited(){if(presets)presets.select.value='';changed();}
  [['expertise','专业深度',{general:'通用讲解 · 清楚易懂',professional:'专业实践 · 方法与取舍',expert:'专家深度 · 假设与边界'},'professional'],['stance','协作方式',{collaborate:'协作推进 · 补充并改进',challenge:'质疑反驳 · 找反例和漏洞',review:'独立审查 · 核对事实与风险'},'collaborate']].forEach(function(spec){
    var wrap=textNode('label',spec[1]),select=document.createElement('select');select.setAttribute('aria-label',label+' 的'+spec[1]);
    Object.keys(spec[2]).forEach(function(value){var option=textNode('option',spec[2][value]);option.value=value;select.append(option);});select.value=profile[spec[0]]||spec[3];
    select.onchange=function(){profile[spec[0]]=select.value;edited();};wrap.append(select);root.append(wrap);
  });
  var labelNode=textNode('label','人格 / 专长说明'),persona=document.createElement('textarea');persona.maxLength=600;persona.value=profile.persona||'';persona.placeholder='例如：严谨的后端工程师，先列证据，重点检查并发与异常处理';persona.setAttribute('aria-label',label+' 的人格说明');
  persona.oninput=function(){profile.persona=persona.value;edited();};labelNode.append(persona);root.append(labelNode);return root;
}
function queueGroupRefresh() {
  groupRefreshDirty=true;if(groupRefreshTimer||groupRefreshing||!groupVisible)return;
  groupRefreshTimer=setTimeout(async function(){groupRefreshTimer=null;if(!session||!groupVisible)return;groupRefreshing=true;groupRefreshDirty=false;
    try{await refreshGroups();}catch(error){groupStatus(groupError(error.message));}finally{groupRefreshing=false;if(groupRefreshDirty)queueGroupRefresh();}
  },120);
}

function resetGroups() {
  resetGroupPresets();
  if (groupStream) groupStream.close(); groupStream = null; groupFetch++; groupCurrent = null; groupCatalog = []; groupPreviewData = null;
  groupChoices = ['', '']; groupWorkspaces = ['', '']; groupReasonings = ['', '']; groupProfiles=[{},{}]; groupMessageNodes.clear();groupRenderedRoom=null;groupEditing=null;groupNode('groupProfileForm').hidden=true;
  if(groupRefreshTimer)clearTimeout(groupRefreshTimer);groupRefreshTimer=null;groupRefreshDirty=false;
  clearNode(groupNode('groupTimeline')); clearNode(groupNode('groupPreview')); clearNode(groupNode('groupList'));
  groupNode('groupMessage').value = ''; groupNode('groupFirstMessage').value = ''; groupNode('groupTitle').value = '';
}
function connectGroups() {
  if (!session || groupStream) return;
  groupStream = new EventSource('/marshal/api/discussions/stream');
  groupStream.onmessage = function() { if (groupVisible) queueGroupRefresh(); };
  groupStream.onerror = function() { if (groupVisible) groupStatus('群聊连接中断，等待恢复；不会重复发送。'); };
}
function groupMode(enabled) {
  groupVisible = enabled; nativeState(); groupNode('singleWorkspace').hidden = enabled; groupNode('groupWorkspace').hidden = !enabled;
  groupNode('singleMode').setAttribute('aria-pressed',String(!enabled)); groupNode('groupMode').setAttribute('aria-pressed',String(enabled));
  if (enabled) { connectGroups(); refreshGroups().catch(function(error){groupStatus(groupError(error.message));}); }
}
function renderGroupChoices() {
  var root = groupNode('groupMembers'); clearNode(root);
  groupChoices.forEach(function(value,index){
    var row = textNode('div','','group-member-choice'), label = textNode('label','成员 ' + (index+1) + (index===Number(groupNode('groupModerator').value)?' · 主持人':'')), select = document.createElement('select');
    select.setAttribute('aria-label','群聊成员 '+(index+1));
    var blank = textNode('option','选择设备与 agent'); blank.value=''; select.append(blank);
    groupCatalog.filter(function(model){return groupNode('groupKind').value!=='work'||index===Number(groupNode('groupModerator').value)||model.work===true;}).forEach(function(model){var option=textNode('option',model.deviceName+' · '+model.agent+' · '+model.model);option.value=JSON.stringify([model.deviceId,model.id]);select.append(option);});
    select.value=value;select.onchange=function(){groupChoices[index]=select.value;groupReasonings[index]='';groupPreviewData=null;groupNode('groupPreview').hidden=true;renderGroupChoices();};
    row.append(label,select);
    var selectedModel=groupCatalog.find(function(model){return JSON.stringify([model.deviceId,model.id])===value;});
    var effortLabel=textNode('label','思考强度'),effort=document.createElement('select'),levels=selectedModel?.reasoningEfforts||[];
    effort.setAttribute('aria-label','成员 '+(index+1)+' 的思考强度');
    var defaultEffort=textNode('option',levels.length?'模型默认':'该模型未提供可选档位');defaultEffort.value='';effort.append(defaultEffort);
    levels.forEach(function(level){var option=textNode('option',groupEffortLabel(level));option.value=level;effort.append(option);});
    if(!levels.includes(groupReasonings[index]))groupReasonings[index]='';
    effort.value=groupReasonings[index]||'';effort.disabled=!levels.length;effort.onchange=function(){groupReasonings[index]=effort.value;groupPreviewData=null;groupNode('groupPreview').hidden=true;};
    effortLabel.append(effort);row.append(effortLabel);
    if(groupNode('groupKind').value==='work'&&index!==Number(groupNode('groupModerator').value)){
      var pathLabel=textNode('label','该设备的项目目录'),path=document.createElement('input');path.value=groupWorkspaces[index]||'';path.placeholder='/绝对路径/项目目录';path.setAttribute('aria-label','成员 '+(index+1)+' 的工作目录');path.oninput=function(){groupWorkspaces[index]=path.value;groupNode('groupPreview').hidden=true;};pathLabel.append(path);row.append(pathLabel);
    }
    var profile=groupProfiles[index]||(groupProfiles[index]={}),details=textNode('details','','group-profile');
    function profileChanged(){groupPreviewData=null;groupNode('groupPreview').hidden=true;}
    var presets=groupPresetControls(profile,'成员 '+(index+1),function(){profileChanged();renderGroupChoices();});row.append(presets.root);
    details.append(textNode('summary','人格与协作细节'),groupProfileFields(profile,'成员 '+(index+1),function(){presets.select.value='';profileChanged();},false));row.append(details);
    if(groupChoices.length>2){var remove=textNode('button','移除');remove.type='button';remove.onclick=function(){groupChoices.splice(index,1);groupWorkspaces.splice(index,1);groupReasonings.splice(index,1);groupProfiles.splice(index,1);renderGroupChoices();};row.append(remove);}
    root.append(row);
  });
  var moderator=groupNode('groupModerator'),selectedModerator=Number(moderator.value)||0;clearNode(moderator);groupChoices.forEach(function(_,index){var option=textNode('option','成员 '+(index+1));option.value=String(index);moderator.append(option);});moderator.value=String(Math.min(selectedModerator,groupChoices.length-1));
  groupNode('groupAddMember').disabled=groupChoices.length>=4;
  groupNode('groupPreviewButton').disabled=groupCatalog.length===0||groupBusy;
  if(!groupCatalog.length)groupStatus('暂时没有可用成员，请确认设备在线并已启用群聊。');
}
function groupState(state) {return ({idle:'等待下一条消息',running:'成员正在回复',stopping:'正在停止',closed:'已结束',unknown:'结果待核对',expired:'已到期'})[state]||state;}
function groupTokens(value) { return new Intl.NumberFormat('en', {notation:'compact',maximumFractionDigits:1}).format(value); }
function groupCoverage(usage) {
  if (!usage || !usage.calls) return '尚未调用';
  return ['已上报 '+usage.reportedCalls+'/'+usage.calls+' 次',usage.pendingCalls?usage.pendingCalls+' 次待回报':'',usage.missingCalls?usage.missingCalls+' 次未上报':'',usage.partialCalls?usage.partialCalls+' 次非完整调用':''].filter(Boolean).join(' · ');
}
function groupUsageText(usage, aggregate) {
  if (!usage) return '用量未上报';
  if (aggregate && !usage.reportedCalls) return !usage.calls?'尚未调用':usage.pendingCalls?'用量待上报':'用量未上报';
  return groupTokens(usage.totalTokens)+' tok'+(usage.durationMs>0?' · 平均 '+(usage.outputTokens*1000/usage.durationMs).toFixed(1)+' tok/s':'');
}
function renderGroupUsage(room) {
  var root=groupNode('groupUsage'),usage=room.usage;clearNode(root);
  root.append(textNode('span','群聊总用量'),textNode('strong',usage&&usage.reportedCalls?groupTokens(usage.totalTokens)+' tok':'— tok'));
  if(usage&&usage.reportedCalls)root.append(textNode('span','输入 '+groupTokens(usage.inputTokens)+' · 输出 '+groupTokens(usage.outputTokens)));
  if(room.calls.some(function(c){return c.state==='pending';}))root.append(textNode('span',groupLiveText(room.calls),'group-live'));
  root.append(textNode('span',groupCoverage(usage)),textNode('small','实时显示模型已上报用量，完成后校准。生成中的可见输出按文字估算，不含未上报的思考/工具 token，不计入已上报总量。平均速度含思考、工具与网络等待。'));
}

function groupLiveText(calls) {
  var live=calls.filter(function(c){return c.state==='pending'&&c.live;}),tokens=live.reduce(function(n,c){return n+c.live.estimatedOutputTokens;},0),ms=live.reduce(function(n,c){return n+c.live.durationMs;},0);
  return live.length?'生成中 · 可见输出估算 ~'+groupTokens(tokens)+' tok'+(ms>0?' · ~'+(tokens*1000/ms).toFixed(1)+' tok/s':''):'生成中 · 等待首段输出';
}
function groupMessageCard(room,message,call) {
  var member=room.members.find(function(m){return m.id===message.author;}),name=message.author==='user'?'你':member?(member.name+' · '+member.model.agent):message.author;
  var streaming=message.state==='streaming'&&call?.state==='pending',card=textNode('article','','group-message '+(message.author==='user'?'user':streaming?'streaming':message.state!=='completed'?'failed':'')),header=document.createElement('header');
  header.append(textNode('strong',name+(streaming?' · 正在生成':'')),textNode('span',new Date(message.at).toLocaleTimeString()));
  var body=message.text;
  if(call?.phase==='planning'){
    if(streaming)body='主持人正在生成任务分工…';
    else if(message.state==='completed'){try{var plan=JSON.parse(body.trim().replace(/^\\x60{3}(?:json)?\\s*/i,'').replace(/\\s*\\x60{3}$/,''));body='主持人分工：\\n'+plan.assignments.map(function(a){var m=room.members.find(function(m){return m.id===a.memberId;});return(m?m.name+' · '+m.model.agent:a.memberId)+'：'+a.task;}).join('\\n\\n');}catch(_){}}
  }
  card.append(header,message.markdown?groupMarkdownBody(message.markdown,body):textNode('p',message.state==='completed'||streaming?body:groupError(message.error||message.text)));
  var copy=textNode('button','复制原文');copy.type='button';copy.onclick=async function(){try{await navigator.clipboard.writeText(message.text);copy.textContent='已复制';}catch(_){copy.textContent='复制未成功';}};header.append(copy);
  if(message.error)card.append(textNode('p','未完成：'+groupError(message.error),'group-note'));
  if(call)card.append(textNode('div',streaming?groupLiveText([call])+(call.usage?' · 已上报 '+groupUsageText(call.usage,false):''):groupUsageText(call.usage,false)+(call.state==='completed'?'':' · 非完整调用'),'group-call-usage'));
  return card;
}
function renderGroupRoom(room) {
  if (!room || !groupCurrent || room.id!==groupCurrent.id) return;
  groupCurrent=room; groupNode('groupDraft').hidden=true;groupNode('groupRoom').hidden=false;groupNode('groupTimeline').hidden=false;groupNode('groupSendForm').hidden=false;
  groupNode('groupRoomTitle').textContent=room.title;groupNode('groupRoomMeta').textContent=(room.state==='running'?({planning:'主持人正在分工',working:room.mode==='work'?'成员正在执行工作':'成员正在回复',summarizing:'主持人正在汇总'}[room.phase]||groupState(room.state)):groupState(room.state))+' · 第 '+room.rounds+'/3 轮 · 内容保留至 '+new Date(room.expiresAt).toLocaleTimeString();
  var roster=groupNode('groupRoster');clearNode(roster);renderGroupUsage(room);
  room.members.forEach(function(member){
    var calls=room.calls.filter(function(c){return c.memberId===member.id;}),active=calls.some(function(c){return c.state==='pending';}),card=textNode('div','','group-chip'+(active?' running':''));
    card.append(textNode('strong',member.name+' · '+member.model.agent+(member.id===room.moderatorId?' · 主持人':'')+(active?' · 处理中':'')),
      textNode('span',member.model.model+' · 思考：'+groupEffortLabel(member.reasoning)+(member.work?' · '+member.work.workspace:''),'group-member-meta'),
      textNode('span',groupProfileSummary(member.profile),'group-member-meta'),
      textNode('span',groupUsageText(member.usage,true),'group-member-usage'),textNode('span',groupCoverage(member.usage),'group-member-meta'));
    if(active)card.append(textNode('span',groupLiveText(calls),'group-member-meta group-live'));
    if(member.usage&&member.usage.reportedCalls)card.title='输入 '+member.usage.inputTokens.toLocaleString()+' tok · 输出 '+member.usage.outputTokens.toLocaleString()+' tok · 总计 '+member.usage.totalTokens.toLocaleString()+' tok';
    var savePreset=textNode('button','存为预设');savePreset.type='button';savePreset.onclick=function(){openGroupPreset(null,member.profile);};card.append(savePreset);
    roster.append(card);
  });
  var timeline=groupNode('groupTimeline'),atBottom=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<80;
  if(groupRenderedRoom!==room.id||room.cleared){clearNode(timeline);groupMessageNodes.clear();groupRenderedRoom=room.id;groupEditing=null;groupNode('groupProfileForm').hidden=true;}
  room.messages.forEach(function(message){
    var call=room.calls.find(function(c){return c.turnId===message.id;}),signature=JSON.stringify([message.text,message.state,message.error,call?.state,call?.usage,call?.live]),prior=groupMessageNodes.get(message.id);
    if(prior?.signature===signature)return;
    var card=groupMessageCard(room,message,call);if(prior)prior.node.replaceWith(card);else timeline.append(card);groupMessageNodes.set(message.id,{signature:signature,node:card});
  });
  if(room.cleared)timeline.append(textNode('p','群聊正文已清除，无法恢复，也不会自动重新调用模型。','group-note'));
  if(atBottom)timeline.scrollTop=timeline.scrollHeight;
  groupNode('groupSend').disabled=groupBusy||room.state!=='idle'||room.cleared||room.rounds>=3;
  groupNode('groupMessage').disabled=groupBusy||room.state!=='idle'||room.cleared||room.rounds>=3;
  groupNode('groupEditProfiles').disabled=groupBusy||room.state!=='idle'||room.cleared;
  if(room.state!=='idle'){groupNode('groupProfileForm').hidden=true;groupEditing=null;}
  groupNode('groupStop').disabled=groupBusy||room.state==='closed';groupNode('groupReconcile').disabled=groupBusy;
}

async function refreshGroups() {
  var ticket=++groupFetch, target=groupCurrent&&groupCurrent.id;
  var data=await groupRequest();if(ticket!==groupFetch||!session)return;
  updateGroupPresets(data.presets||null);
  var signature=JSON.stringify(data.catalog||[]);if(signature!==JSON.stringify(groupCatalog)){groupCatalog=data.catalog||[];if(!groupCurrent)renderGroupChoices();}
  var list=groupNode('groupList');clearNode(list);
  (data.rooms||[]).slice().reverse().forEach(function(room){var button=textNode('button',room.title+' · '+groupState(room.state),'row'+(target===room.id?' active':''));button.type='button';button.onclick=async function(){groupCurrent={id:room.id};groupStatus('');try{var data=await groupRequest(null,'?room='+encodeURIComponent(room.id));if(groupCurrent&&groupCurrent.id===room.id)renderGroupRoom(data.room);}catch(error){groupStatus(groupError(error.message));}};list.append(button);});
  if(target){var selected=await groupRequest(null,'?room='+encodeURIComponent(target));if(ticket===groupFetch&&groupCurrent&&groupCurrent.id===target)renderGroupRoom(selected.room);}
}
async function groupAction(fn) {
  if(groupBusy)return;groupBusy=true;groupStatus('');if(groupCurrent)renderGroupRoom(groupCurrent);else groupNode('groupPreviewButton').disabled=true;
  try {await fn();}catch(error){groupStatus(groupError(error.message));}finally{groupBusy=false;if(groupCurrent)renderGroupRoom(groupCurrent);else groupNode('groupPreviewButton').disabled=!groupCatalog.length;}
}

groupNode('groupEditProfiles').onclick=function(){
  if(!groupCurrent||groupCurrent.state!=='idle')return;
  groupEditing={id:groupCurrent.id,revision:groupCurrent.revision,profiles:groupCurrent.members.map(function(m){return{memberId:m.id,profile:Object.assign({},m.profile||{})};})};
  var fields=groupNode('groupProfileFields');clearNode(fields);
  groupCurrent.members.forEach(function(m,i){var card=textNode('div','','group-chip'),label=m.name+' · '+m.model.agent;card.append(textNode('strong',label),groupProfileFields(groupEditing.profiles[i].profile,label,function(){}));fields.append(card);});
  groupNode('groupProfileForm').hidden=false;
};
groupNode('groupProfileCancel').onclick=function(){groupEditing=null;groupNode('groupProfileForm').hidden=true;};
groupNode('groupProfileForm').onsubmit=function(event){event.preventDefault();var edit=groupEditing;if(!edit)return;return groupAction(async function(){
  var result=await groupRequest({action:'configure',roomId:edit.id,revision:edit.revision,profiles:edit.profiles});
  if(groupCurrent?.id===edit.id){groupEditing=null;groupNode('groupProfileForm').hidden=true;renderGroupRoom(result.room);groupStatus('成员设置已保存，将用于下一轮。');}
});};
groupNode('singleMode').onclick=function(){groupMode(false);};groupNode('groupMode').onclick=function(){groupMode(true);};
groupNode('groupNew').onclick=function(){groupCurrent=null;groupPreviewData=null;groupFetch++;groupRenderedRoom=null;groupMessageNodes.clear();groupNode('groupProfileForm').hidden=true;groupNode('groupDraft').hidden=false;groupNode('groupRoom').hidden=true;groupNode('groupTimeline').hidden=true;groupNode('groupSendForm').hidden=true;groupNode('groupPreview').hidden=true;clearNode(groupNode('groupTimeline'));groupStatus('');renderGroupChoices();};
groupNode('groupKind').onchange=function(){groupNode('groupPreview').hidden=true;renderGroupChoices();};
groupNode('groupModerator').onchange=function(){groupNode('groupPreview').hidden=true;renderGroupChoices();};
groupNode('groupAddMember').onclick=function(){if(groupChoices.length<4){groupChoices.push('');groupWorkspaces.push('');groupReasonings.push('');groupProfiles.push({});renderGroupChoices();}};
groupNode('groupCreateForm').onsubmit=function(event){event.preventDefault();return groupAction(async function(){
  if(groupChoices.some(function(c){return !c;}))throw new Error('invalid-args');
  var input={mode:groupNode('groupKind').value,title:groupNode('groupTitle').value.trim(),text:groupNode('groupFirstMessage').value.trim(),moderator:Number(groupNode('groupModerator').value),members:groupChoices.map(function(c,index){var v=JSON.parse(c);var member={deviceId:v[0],modelId:v[1],profile:groupProfiles[index]||{}};if(groupReasonings[index])member.reasoning=groupReasonings[index];if(groupNode('groupKind').value==='work'&&index!==Number(groupNode('groupModerator').value))member.workspace=(groupWorkspaces[index]||'').trim();return member;})};
  var data=await groupRequest({action:'preview',input:input});groupPreviewData=data.preview;var root=groupNode('groupPreview');clearNode(root);root.hidden=false;
  root.append(textNode('h3','确认共享范围'),textNode('p',data.preview.mode==='work'?'执行成员将读取指定项目、修改该目录内的文件并运行命令；模型会收到任务、相关项目内容和执行结果。主机网络与提权操作不可用。主持人仅负责分工与汇总。':'下面的内容与本群后续回复将交给所选设备及其模型服务。每位成员使用独立、无工具的讨论环境。'),textNode('pre',data.preview.text));
  data.preview.members.forEach(function(m){var model=groupCatalog.find(function(x){return x.deviceId===m.deviceId&&x.id===m.model.id;});root.append(textNode('p',(model?model.deviceName:m.deviceId)+' · '+m.model.agent+' / '+m.model.model+' · 思考：'+groupEffortLabel(m.reasoning)+(m.id===data.preview.moderatorId?' · 主持人':'')+(m.work?' · 工作目录：'+m.work.workspace:'')+' · '+groupProfileSummary(m.profile)));});
  root.append(textNode('p','最多 '+data.preview.maxCalls+' 次模型调用；主持人将自动分工、收集回复并汇总。','group-note'));
  var start=textNode('button',data.preview.mode==='work'?'确认范围并开始执行':'确认并开始群聊','primary');start.type='button';start.onclick=function(){return groupAction(async function(){var result=await groupWrite({action:'create',digest:data.preview.digest},'create:'+data.preview.digest);groupCurrent=result.room;renderGroupRoom(result.room);await refreshGroups();});};root.append(start);
});};
groupNode('groupSendForm').onsubmit=function(event){event.preventDefault();return groupAction(async function(){if(!groupCurrent)return;var text=groupNode('groupMessage').value.trim();if(!text)return;var result=await groupWrite({action:'send',roomId:groupCurrent.id,text:text,recipient:'moderator'},'send:'+groupCurrent.id);groupNode('groupMessage').value='';renderGroupRoom(result.room);});};
groupNode('groupStop').onclick=function(){return groupAction(async function(){if(groupCurrent){var result=await groupRequest({action:'stop',roomId:groupCurrent.id});renderGroupRoom(result.room);}});};
groupNode('groupReconcile').onclick=function(){return groupAction(async function(){if(groupCurrent){var result=await groupRequest({action:'reconcile',roomId:groupCurrent.id});renderGroupRoom(result.room);if(result.room.state!=='unknown'&&result.room.state!=='running'){groupKey('send:'+groupCurrent.id).clear();groupStatus('已核对源端状态；未重新发送消息。');}}});};
`;
