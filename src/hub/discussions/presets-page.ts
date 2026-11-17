export const PRESETS_CSS = `
.group-preset-controls { grid-column:1/-1; display:grid; gap:8px; }
.group-preset-controls label { display:grid; gap:5px; font-size:12px; color:var(--muted); }
.group-preset-controls button { justify-self:start; font-size:12px; }
.group-preset-panel { border:1px solid var(--line); border-radius:10px; padding:18px; }
.group-preset-panel header { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.group-preset-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:8px; margin:12px 0; }
.group-preset-list button { text-align:left; overflow-wrap:anywhere; }
.group-preset-list small { display:block; font-weight:normal; color:var(--muted); margin-top:5px; }
.group-preset-panel form { margin-top:14px; display:grid; gap:12px; }
.group-preset-panel form > label { display:grid; gap:5px; }
.group-preset-panel form input { max-width:440px; }
.group-preset-panel .group-profile-fields { margin-top:0; }
.group-preset-panel [role=status] { color:var(--muted); font-size:12px; margin-top:10px; }
`

export const PRESETS_HTML = `
<section id="groupPresetPanel" class="group-preset-panel" aria-label="Agent 预设库" hidden>
  <header><h2>Agent 预设库</h2><button id="groupPresetClose" type="button">收起预设库</button></header>
  <p class="group-note">同一账号的设备共享预设。应用后可单独调整；编辑或删除预设不影响已创建的群聊。</p>
  <div id="groupPresetList" class="group-preset-list"></div>
  <button id="groupPresetNew" type="button">＋ 新建预设</button>
  <form id="groupPresetForm" hidden>
    <label>预设名称<input id="groupPresetName" maxlength="60" required placeholder="例如：后端安全审查员"></label>
    <div id="groupPresetFields"></div>
    <div class="group-actions"><button id="groupPresetSave" class="primary" type="submit">保存预设</button><button id="groupPresetReload" type="button">重新载入已保存版本</button><button id="groupPresetDelete" type="button">删除预设</button></div>
  </form>
  <p id="groupPresetStatus" role="status" aria-live="polite"></p>
</section>
`

export const PRESETS_SCRIPT = `
var groupPresets=null,groupPresetEditor=null,groupPresetBusy=false,groupPresetGeneration=0;
function profileCopy(profile) { return {persona:profile?.persona||'',expertise:profile?.expertise||'professional',stance:profile?.stance||'collaborate'}; }
function presetOptions(select, selected) {
  clearNode(select);var custom=textNode('option',groupPresets?'自定义设置':'正在读取预设…');custom.value='';select.append(custom);
  (groupPresets?.items||[]).forEach(function(preset){var option=textNode('option',preset.name);option.value=preset.id;select.append(option);});
  select.value=(groupPresets?.items||[]).some(function(p){return p.id===selected;})?selected:'';select.disabled=!groupPresets;
}
function groupPresetControls(profile,label,applied) {
  var root=textNode('div','','group-preset-controls'),wrap=textNode('label','Agent 预设'),select=document.createElement('select');
  select.setAttribute('aria-label',label+' 的预设');select.setAttribute('data-group-preset','');
  select.marshalProfile=profile;
  var match=groupPresets?.items.find(function(p){return JSON.stringify(profileCopy(p.profile))===JSON.stringify(profileCopy(profile));});presetOptions(select,match?.id);
  select.onchange=function(){var preset=groupPresets?.items.find(function(p){return p.id===select.value;});if(preset){Object.assign(profile,profileCopy(preset.profile));applied();}};
  wrap.append(select);var save=textNode('button','将当前设置存为预设');save.type='button';save.onclick=function(){openGroupPreset(null,profile,select);};root.append(wrap,save);return {root:root,select:select};
}
function updateGroupPresets(value) {
  if(groupPresets?.revision===value?.revision&&!!groupPresets===!!value)return;
  groupPresets=value;
  document.querySelectorAll('[data-group-preset]').forEach(function(select){
    var preset=groupPresets?.items.find(function(p){return p.id===select.value;});
    // Keep the member snapshot, but do not label it as the newly edited preset.
    var selected=preset&&JSON.stringify(profileCopy(preset.profile))===JSON.stringify(profileCopy(select.marshalProfile))?select.value:'';
    presetOptions(select,selected);
  });
  renderGroupPresetList();
}
function renderGroupPresetList() {
  var list=groupNode('groupPresetList');clearNode(list);groupNode('groupPresetNew').disabled=!groupPresets;
  if(!groupPresets){list.append(textNode('p','预设库暂不可用，群聊仍可使用。','group-note'));return;}
  groupPresets.items.forEach(function(preset){var button=textNode('button',preset.name);button.type='button';button.append(textNode('small',groupProfileSummary({expertise:preset.profile.expertise,stance:preset.profile.stance})));button.onclick=function(){if(!groupPresetBusy)openGroupPreset(preset);};list.append(button);});
  if(!groupPresets.items.length)list.append(textNode('p','还没有预设，可以新建，或从成员设置保存。','group-note'));
}
function openGroupPreset(preset,profile,source) {
  groupNode('groupPresetPanel').hidden=false;renderGroupPresetList();
  if(!groupPresets||groupPresetBusy)return;
  groupPresetEditor={id:preset?.id||newKey(),revision:groupPresets.revision,key:newKey(),existing:!!preset,profile:profileCopy(preset?.profile||profile),source:source,sourceProfile:profile};
  groupNode('groupPresetForm').hidden=false;groupNode('groupPresetName').value=preset?.name||'';
  var fields=groupNode('groupPresetFields');clearNode(fields);fields.append(groupProfileFields(groupPresetEditor.profile,'预设',function(){},false));
  groupNode('groupPresetDelete').hidden=!preset;groupNode('groupPresetDelete').textContent='删除预设';groupNode('groupPresetReload').hidden=false;groupNode('groupPresetReload').textContent=preset?'重新载入已保存版本':'保留输入并同步列表';
  groupNode('groupPresetStatus').textContent=preset?'修改将同步到其他设备；已应用到成员的设置保持不变。':'填写名称，将这组设置保存到你的调度空间。';
  groupNode('groupPresetPanel').scrollIntoView({block:'nearest'});
}
async function writeGroupPreset(action) {
  var edit=groupPresetEditor;if(!edit||groupPresetBusy)return;
  var generation=groupPresetGeneration,input={action:action,id:edit.id,key:edit.key,revision:edit.revision};
  if(action==='save'){input.name=groupNode('groupPresetName').value;input.profile=profileCopy(edit.profile);}
  groupPresetBusy=true;groupNode('groupPresetSave').disabled=true;groupNode('groupPresetDelete').disabled=true;groupNode('groupPresetReload').disabled=true;
  try {
    var result=await groupRequest({action:'preset',input:input});if(generation!==groupPresetGeneration)return;
    updateGroupPresets(result.presets);
    if(action==='save'){
      var saved=groupPresets.items.find(function(p){return p.id===edit.id;});openSavedGroupPreset(saved);
      if(edit.source?.isConnected&&JSON.stringify(profileCopy(edit.sourceProfile))===JSON.stringify(profileCopy(saved.profile)))edit.source.value=saved.id;
      groupNode('groupPresetStatus').textContent='预设已保存，同一账号的其他设备会自动同步。';
    }else{groupPresetEditor=null;groupNode('groupPresetForm').hidden=true;groupNode('groupPresetStatus').textContent='预设已删除，已有群成员设置保持不变。';}
  }catch(error){
    if(generation!==groupPresetGeneration)return;
    var messages={'preset-name-conflict':'这个名称已存在，请换一个名称。','preset-unknown':'预设已被另一台设备删除，请新建或选择其他预设。','revision-conflict':'预设库已被另一台设备修改。你的输入已保留，请重新载入已保存版本后再编辑。','recovery-required':'预设暂时无法保存，请稍后重试。'};
    groupNode('groupPresetStatus').textContent=messages[error.message]||groupError(error.message);queueGroupRefresh();
  }finally{if(generation===groupPresetGeneration){groupPresetBusy=false;groupNode('groupPresetSave').disabled=false;groupNode('groupPresetDelete').disabled=false;groupNode('groupPresetReload').disabled=false;}}
}
function openSavedGroupPreset(saved) {
  // Updating the editor after an acknowledged save is independent of the busy UI guard.
  groupPresetEditor={id:saved.id,revision:groupPresets.revision,key:newKey(),existing:true,profile:profileCopy(saved.profile)};
  groupNode('groupPresetName').value=saved.name;groupNode('groupPresetDelete').hidden=false;groupNode('groupPresetDelete').textContent='删除预设';groupNode('groupPresetReload').hidden=false;groupNode('groupPresetReload').textContent='重新载入已保存版本';
  var fields=groupNode('groupPresetFields');clearNode(fields);fields.append(groupProfileFields(groupPresetEditor.profile,'预设',function(){},false));
}
function resetGroupPresets(){groupPresetGeneration++;groupPresets=null;groupPresetEditor=null;groupPresetBusy=false;groupNode('groupPresetPanel').hidden=true;groupNode('groupPresetForm').hidden=true;clearNode(groupNode('groupPresetList'));clearNode(groupNode('groupPresetFields'));groupNode('groupPresetName').value='';groupNode('groupPresetStatus').textContent='';['groupPresetSave','groupPresetDelete','groupPresetReload'].forEach(function(id){groupNode(id).disabled=false;});}
groupNode('groupPresetLibrary').onclick=function(){groupNode('groupPresetPanel').hidden=!groupNode('groupPresetPanel').hidden;renderGroupPresetList();};
groupNode('groupPresetClose').onclick=function(){groupNode('groupPresetPanel').hidden=true;};
groupNode('groupPresetNew').onclick=function(){openGroupPreset(null,{});};
groupNode('groupPresetReload').onclick=function(){var saved=groupPresets?.items.find(function(p){return p.id===groupPresetEditor?.id;}),name=groupNode('groupPresetName').value;openGroupPreset(saved||null,groupPresetEditor?.profile);if(!saved)groupNode('groupPresetName').value=name;};
groupNode('groupPresetForm').onsubmit=function(event){event.preventDefault();return writeGroupPreset('save');};
groupNode('groupPresetDelete').onclick=function(){if(!groupPresetEditor?.existing)return;if(this.textContent==='删除预设'){this.textContent='确认删除（已有群聊不受影响）';return;}return writeGroupPreset('delete');};
`
