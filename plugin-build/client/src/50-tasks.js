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
