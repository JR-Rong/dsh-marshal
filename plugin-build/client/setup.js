function marshalSetup(React) {
  const h = React.createElement;
  const errors = { 'account-required': '请先在 DeepSeek Harness 左下角登录账号，登录后会自动继续。', 'account-mismatch': '当前 DSH 账号与该中心绑定的账号不同。', revoked: '此设备已被中心撤销，无法自动重新加入。', 'duplicate-id': '设备凭据与已有安装不一致，请恢复原安装状态。', 'runtime-unavailable': '配置已保存，但服务启动失败，请检查插件日志。' };
  const request = async body => {
    const response = await fetch(new URL('marshal/setup', document.baseURI), { method: 'POST', headers: { 'x-marshal-setup': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw Error(data.code); return data;
  };
  function Setup({ initial, onReady }) {
    const [role, setRole] = React.useState(initial.role || 'node');
    const [origin, setOrigin] = React.useState(initial.origin);
    const [name, setName] = React.useState(initial.name);
    const [share, setShare] = React.useState(initial.shareContent ?? true);
    const [status, setStatus] = React.useState(initial);
    const [busy, setBusy] = React.useState(false);
    const locked = busy || status.busy || status.configured;
    React.useEffect(() => {
      let closed = false, checking = false;
      const timer = setInterval(async () => {
        if (checking) return; checking = true;
        try { const next = await request({ action: 'status' }); if (!closed) { setStatus(next); if (next.ready) onReady(); } } catch {} finally { checking = false; }
      }, 3000);
      return () => { closed = true; clearInterval(timer); };
    }, []);
    const save = async event => {
      event.preventDefault(); if (busy) return; setBusy(true);
      try { const next = await request({ action: 'save', choice: { role, origin, name, shareContent: share } }); setStatus(next); if (next.ready) onReady(); }
      catch (error) { setStatus({ code: error.message }); } finally { setBusy(false); }
    };
    return h('div', { className: 'marshal-setup' },
      h('style', null, '.marshal-setup{max-width:760px;width:100%;margin:auto;padding:36px;box-sizing:border-box}.marshal-setup h2{font-size:26px;margin:0 0 10px}.marshal-setup p{opacity:.65;line-height:1.7}.marshal-setup .roles{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:26px 0}.marshal-setup .role{display:flex;gap:10px;border:1px solid #8885;border-radius:12px;padding:18px;cursor:pointer}.marshal-setup .role.selected{border-color:#81c6b0;background:#81c6b011}.marshal-setup .role small{display:block;opacity:.6;line-height:1.6;margin-top:6px}.marshal-setup .field{display:grid;gap:8px;margin:18px 0;font-size:13px}.marshal-setup input[type=text],.marshal-setup input[type=url]{background:transparent;color:inherit;border:1px solid #8885;border-radius:8px;padding:12px;font:inherit}.marshal-setup button{border:0;border-radius:8px;padding:12px 18px;background:#81c6b0;color:#142820;font:inherit;cursor:pointer}.marshal-setup button:disabled{opacity:.5}.marshal-setup .hint{font-size:12px}@media(max-width:600px){.marshal-setup{padding:20px}.marshal-setup .roles{grid-template-columns:1fr}}'),
      h('h2', null, status.configured ? '正在启动调度官' : '这台设备，如何参与协作？'),
      h('p', null, '选好角色，使用当前 DSH 账号连接你的调度空间。'),
      h('form', { onSubmit: save },
        h('div', { className: 'roles', role: 'radiogroup', 'aria-label': '设备角色' },
          ...[['node', '边缘主机', '提供本机 DSH、Codex 执行工作。已有云端中心时，Mac 选择这一项。'], ['hub', '中心服务器', '建立独立调度中心，管理设备和转发任务；本机不运行执行成员。']].map(([value, label, detail]) =>
            h('label', { key: value, className: 'role' + (role === value ? ' selected' : '') }, h('input', { type: 'radio', name: 'marshal-role', value, checked: role === value, disabled: locked,
              onChange: () => { setRole(value); setOrigin(value === 'node' ? initial.origin : ''); } }), h('span', null, h('strong', null, label), h('small', null, detail))))),
        h('label', { className: 'field' }, '设备名称', h('input', { type: 'text', value: name, maxLength: 80, required: true, disabled: locked, onChange: e => setName(e.target.value) })),
        h('label', { className: 'field' }, role === 'node' ? '调度中心地址' : '此中心的 HTTPS 访问地址', h('input', { type: 'url', value: origin, placeholder: 'https://服务器地址', required: true, disabled: locked, onChange: e => setOrigin(e.target.value) })),
        role === 'hub' ? h('p', { className: 'hint' }, '请将此 HTTPS 地址的 /marshal 路径转发到本机 DSH 服务，并配置可信证书。中心绑定当前 DSH 账号，不会取代已有云端中心。')
          : h('label', { className: 'hint' }, h('input', { type: 'checkbox', checked: share, disabled: locked, onChange: e => setShare(e.target.checked) }), ' 允许本账号查看会话内容、继续会话和使用工作群；审批权限保持关闭。'),
        h('p', { role: 'status' }, status.code ? errors[status.code] || '暂时无法连接中心，请检查地址和网络；会自动重试。' : status.chosen ? '正在连接账号并注册设备…' : '不需要复制 token 或手动注册设备。'),
        !status.configured && h('button', { type: 'submit', disabled: locked }, busy ? '正在连接…' : role === 'node' ? '保存并自动加入' : '保存并创建中心')));
  }
  return { Setup, readSetup: () => request({ action: 'status' }) };
}
