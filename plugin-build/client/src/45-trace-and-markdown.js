    const MARSHAL_TRACE_PREFIX = '<!--marshal-trace:';
    const MARSHAL_TRACE_SUFFIX = '-->\n';
    function decodeAgentTraceClient(rawText) {
      const raw = String(rawText ?? '');
      if (!raw.startsWith(MARSHAL_TRACE_PREFIX)) return { text: raw, trace: null };
      const endIdx = raw.indexOf(MARSHAL_TRACE_SUFFIX, MARSHAL_TRACE_PREFIX.length);
      if (endIdx === -1 || endIdx > 48 * 1024) return { text: raw, trace: null };
      try {
        const parsed = JSON.parse(raw.slice(MARSHAL_TRACE_PREFIX.length, endIdx));
        const rest = raw.slice(endIdx + MARSHAL_TRACE_SUFFIX.length);
        return parsed && typeof parsed === 'object' ? { text: rest, trace: parsed } : { text: raw, trace: null };
      } catch {
        return { text: raw, trace: null };
      }
    }

    function formatTokenCount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
      if (value >= 1_000_000) return (value / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
      if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      return String(Math.round(value));
    }

    function formatUsageTitle(usage) {
      if (!usage || typeof usage !== 'object') return '';
      const total = Number(usage.totalTokens || ((usage.inputTokens || 0) + (usage.outputTokens || 0)));
      if (!total) return '';
      const parts = [
        '总计 ' + total.toLocaleString() + ' tokens',
        '输入 ' + Number(usage.inputTokens || 0).toLocaleString(),
        '输出 ' + Number(usage.outputTokens || 0).toLocaleString(),
      ];
      if (usage.reasoningTokens) parts.push('思考 ' + Number(usage.reasoningTokens).toLocaleString());
      return parts.join(' · ');
    }

    function AgentUsageBadge({ usage }) {
      if (!usage || typeof usage !== 'object') return null;
      const total = Number(usage.totalTokens || ((usage.inputTokens || 0) + (usage.outputTokens || 0)));
      if (!total || total <= 0) return null;
      const inShort = formatTokenCount(Number(usage.inputTokens || 0)) || '0';
      const outShort = formatTokenCount(Number(usage.outputTokens || 0)) || '0';
      return h('span', { className: 'mtr-tok-badge', title: formatUsageTitle(usage) },
        '🪙 ' + formatTokenCount(total) + ' tok (入 ' + inShort + ' · 出 ' + outShort + ')');
    }

    function AgentTracePanel({ trace, live = false, hasBody = true }) {
      if (!trace || typeof trace !== 'object') return null;
      const steps = Array.isArray(trace.steps) ? trace.steps.filter(s => s && s.label) : [];
      const thinking = typeof trace.thinking === 'string' ? trace.thinking.trim() : '';
      const usage = trace.usage && typeof trace.usage === 'object' && (trace.usage.totalTokens > 0 || trace.usage.inputTokens > 0 || trace.usage.outputTokens > 0)
        ? trace.usage : null;
      if (!thinking && steps.length === 0 && !live) return null;
      const stepCount = typeof trace.stepCount === 'number' && trace.stepCount > steps.length ? trace.stepCount : steps.length;
      const durSec = typeof trace.durationMs === 'number' && trace.durationMs > 0
        ? (trace.durationMs >= 1000 ? (trace.durationMs / 1000).toFixed(1) + 's' : trace.durationMs + 'ms')
        : '';
      const metaParts = [];
      if (thinking) metaParts.push('含思考链');
      if (stepCount > 0) metaParts.push(stepCount + ' 步处理');
      if (usage) metaParts.push('消耗 ' + formatTokenCount(usage.totalTokens || (usage.inputTokens + usage.outputTokens)) + ' tok');
      if (trace.model) metaParts.push(trace.model);
      if (durSec && !live) metaParts.push('耗时 ' + durSec);
      const summaryLabel = live
        ? ('💭 实时思考与处理追踪' + (metaParts.length ? ' · ' + metaParts.join(' · ') : ''))
        : ('💭 思考与处理过程' + (metaParts.length ? '（' + metaParts.join(' · ') + '）' : ''));
      return h('details', { className: 'mtr-trace', open: live || !hasBody ? true : undefined },
        h('summary', { className: 'mtr-trace-sum' }, summaryLabel),
        h('div', { className: 'mtr-trace-body' },
          usage && h('div', { className: 'mtr-trace-usage' }, '🪙 ' + formatUsageTitle(usage)),
          steps.length > 0 && h('div', { className: 'mtr-trace-steps' },
            steps.map((st, idx) => {
              const icon = st.status === 'running' ? '⟳' : st.status === 'failed' ? '✕' : '✓';
              return h('div', { key: idx, className: 'mtr-trace-step', 'data-st': st.status || 'done' },
                h('span', { style: { flexShrink: 0, fontWeight: 700 } }, icon),
                h('span', { style: { flex: 1, minWidth: 0 } }, st.label),
                st.detail && h('span', { style: { opacity: .72, fontSize: 10.5, flexShrink: 0 } }, st.detail));
            })),
          thinking
            ? h('div', { className: 'mtr-trace-think' }, thinking)
            : (live && steps.length === 0 && h('div', { style: { ...uiMuted, fontSize: 11.5 } }, '已发起请求，等待模型首包与推演流返回…'))));
    }

    function tryParseJsonPayload(str) {
      const trimmed = String(str || '').trim();
      if (!trimmed) return undefined;
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') return parsed;
        } catch { /* not pure JSON */ }
      }
      return undefined;
    }

    function normalizeMessageMarkdown(rawText, phase) {
      const source = String(rawText ?? '');
      const trimmed = source.trim();
      if (!trimmed) return { markdown: '', rawJson: '' };

      // 1) Pure JSON object / array: convert known agent protocol schemas into readable Markdown + collapsible raw JSON,
      //    or wrap arbitrary JSON into a formatted ```json code block!
      const parsed = tryParseJsonPayload(trimmed);
      if (parsed !== undefined) {
        const pretty = JSON.stringify(parsed, null, 2);
        if (!Array.isArray(parsed)) {
          if ((parsed.action === 'codex' || parsed.action === 'continue') && typeof parsed.instruction === 'string') {
            const actionTitle = parsed.action === 'codex' ? '🔧 **委派 Codex 子 Agent 执行**' : '➡️ **阶段判断：继续下一步**';
            return { markdown: actionTitle + '\n\n' + parsed.instruction.trim(), rawJson: pretty };
          }
          if (['pass', 'revise', 'blocked'].includes(parsed.verdict) && parsed.findings !== undefined) {
            const verdictMap = {
              pass: '✅ **审查结论：通过（pass）**',
              revise: '↩ **审查结论：需返工调整（revise）**',
              blocked: '⚖️ **审查结论：待裁决 / 阻塞（blocked）**',
            };
            const body = Array.isArray(parsed.findings)
              ? parsed.findings.map(f => (f && typeof f === 'object'
                ? '- **`' + String(f.file || '文件') + '`**：' + String(f.conclusion || '')
                : '- ' + String(f))).join('\n')
              : String(parsed.findings || '');
            return { markdown: verdictMap[parsed.verdict] + '\n\n' + body, rawJson: pretty };
          }
          if (phase === 'assignment' || (parsed.roles && (parsed.template || parsed.leader))) {
            const roleLines = Object.entries(parsed.roles || {}).map(([role, who]) => '- **' + role + '**：' + who);
            const codexLine = parsed.codex
              ? '- **Codex 槽位**：编码 `' + (parsed.codex.coding ?? '关闭') + '` / 审查 `' + (parsed.codex.review ?? '关闭') + '`'
              : '';
            const head = '📋 **编排分工配置** · `' + (parsed.template || '普通任务') + '`'
              + (parsed.group ? '（' + parsed.group + '）' : '')
              + (parsed.leader ? ' · Leader：**' + parsed.leader + '**' : '');
            return { markdown: [head, '', ...roleLines, codexLine].filter(Boolean).join('\n'), rawJson: pretty };
          }
        }
        return { markdown: '```json\n' + pretty + '\n```', rawJson: '' };
      }

      // 2) If raw unified diff without code fences, wrap in ```diff
      if (!trimmed.includes('```') && /^(diff --git |--- a\/|\+\+\+ b\/|@@ -\d+)/m.test(trimmed) && /^diff --git /m.test(trimmed)) {
        return { markdown: '```diff\n' + trimmed + '\n```', rawJson: '' };
      }

      // 3) Auto-wrap standalone single-line or trailing raw JSON objects outside existing code fences
      if (!trimmed.includes('```')) {
        const lines = source.split('\n');
        const converted = [];
        let codeCandidateLines = 0;
        for (const line of lines) {
          const t = line.trim();
          const lineJson = (t.startsWith('{') && t.endsWith('}') && t.length > 12) ? tryParseJsonPayload(t) : undefined;
          if (lineJson !== undefined) {
            converted.push('```json\n' + JSON.stringify(lineJson, null, 2) + '\n```');
            continue;
          }
          if (/^(import\s+.+\s+from\s+|export\s+(async\s+)?(function|const|class)\s+|function\s+\w+\s*\(|const\s+\w+\s*=\s*|def\s+\w+\s*\(|class\s+\w+)/.test(t)) {
            codeCandidateLines += 1;
          }
          converted.push(line);
        }
        const joined = converted.join('\n');
        const hasMarkdownMarkers = /(^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|\*\*[^*]+\*\*|^>\s)/m.test(joined);
        if (!hasMarkdownMarkers && codeCandidateLines >= 2 && lines.length >= 3) {
          return { markdown: '```code\n' + trimmed + '\n```', rawJson: '' };
        }
        return { markdown: joined, rawJson: '' };
      }

      return { markdown: source, rawJson: '' };
    }

    function CopyCodeButton({ code }) {
      const [copied, setCopied] = React.useState(false);
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch { /* clipboard unavailable */ }
      };
      return h('button', { type: 'button', className: 'mtr-code-copy', onClick: () => { void copy(); } }, copied ? '✓ 已复制' : '复制代码');
    }

    function CodeFenceBlock({ language, code }) {
      return h('div', { className: 'mtr-code-box' },
        h('div', { className: 'mtr-code-bar' },
          h('span', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600 } }, language || 'code'),
          h(CopyCodeButton, { code })),
        h('pre', { className: 'mtr-code-pre' }, h('code', null, code)));
    }

    function safeExternalUrl(raw) {
      try {
        const u = new URL(raw);
        if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password) return u.href;
      } catch { /* ignore */ }
      return '';
    }

    function renderInlineMarkdown(text, keyPrefix = 'in') {
      const str = String(text ?? '');
      if (!str) return null;
      const tokenRe = /(`[^`\n]+`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*]+)\*\*)|(~~([^~]+)~~)|(\*([^*\s][^*]*?)\*)|((?:^|(?<=\s))@([^\s@,，。！!？?：:;；()（）\[\]【】]{1,24}))/g;
      const out = [];
      let last = 0;
      let match;
      let idx = 0;
      while ((match = tokenRe.exec(str)) !== null) {
        if (match.index > last) out.push(str.slice(last, match.index));
        const k = keyPrefix + '-' + (idx++);
        if (match[1]) {
          out.push(h('code', { key: k, className: 'mtr-inline-code' }, match[1].slice(1, -1)));
        } else if (match[2]) {
          const href = safeExternalUrl(match[4]);
          out.push(href
            ? h('a', { key: k, href, target: '_blank', rel: 'noopener noreferrer' }, match[3])
            : match[0]);
        } else if (match[5]) {
          out.push(h('strong', { key: k }, renderInlineMarkdown(match[6], k + 'b')));
        } else if (match[7]) {
          out.push(h('del', { key: k }, renderInlineMarkdown(match[8], k + 'd')));
        } else if (match[9]) {
          out.push(h('em', { key: k }, renderInlineMarkdown(match[10], k + 'i')));
        } else if (match[11]) {
          out.push(h('span', { key: k, className: 'mtr-mention' }, '@' + match[12]));
        }
        last = tokenRe.lastIndex;
      }
      if (last < str.length) out.push(str.slice(last));
      return out.length === 1 ? out[0] : out;
    }

    function parseMarkdownBlocks(markdown) {
      const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
      const blocks = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        // Fenced code block
        const fenceMatch = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)\s*$/.exec(line);
        if (fenceMatch) {
          const marker = fenceMatch[1];
          const lang = fenceMatch[2] || '';
          const buf = [];
          i += 1;
          while (i < lines.length && !new RegExp('^\\s*' + marker[0] + '{' + marker.length + ',}\\s*$').test(lines[i])) {
            buf.push(lines[i]);
            i += 1;
          }
          if (i < lines.length) i += 1;
          blocks.push({ type: 'code', lang, code: buf.join('\n') });
          continue;
        }
        if (line.trim() === '') {
          i += 1;
          continue;
        }
        // Horizontal rule
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push({ type: 'hr' });
          i += 1;
          continue;
        }
        // Heading
        const headMatch = /^\s*(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (headMatch) {
          blocks.push({ type: 'heading', level: headMatch[1].length, text: headMatch[2] });
          i += 1;
          continue;
        }
        // GFM Table
        if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
          const splitRow = raw => raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
          const header = splitRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
            rows.push(splitRow(lines[i]));
            i += 1;
          }
          blocks.push({ type: 'table', header, rows });
          continue;
        }
        // Blockquote
        if (/^\s*>\s?/.test(line)) {
          const qLines = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            qLines.push(lines[i].replace(/^\s*>\s?/, ''));
            i += 1;
          }
          blocks.push({ type: 'quote', text: qLines.join('\n') });
          continue;
        }
        // List (unordered or ordered)
        const listMatch = /^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line);
        if (listMatch) {
          const ordered = Boolean(listMatch[3]);
          const start = ordered ? Number(listMatch[3]) : 1;
          const items = [];
          while (i < lines.length) {
            const m = /^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(lines[i]);
            if (!m || Boolean(m[3]) !== ordered) break;
            let itemText = m[4];
            let taskCheck = null;
            const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(itemText);
            if (taskMatch) {
              taskCheck = taskMatch[1].toLowerCase() === 'x';
              itemText = taskMatch[2];
            }
            items.push({ text: itemText, checked: taskCheck });
            i += 1;
          }
          blocks.push({ type: 'list', ordered, start, items });
          continue;
        }
        // Paragraph
        const pLines = [line];
        i += 1;
        while (
          i < lines.length
          && lines[i].trim() !== ''
          && !/^\s*(`{3,}|~{3,})/.test(lines[i])
          && !/^\s*#{1,6}\s+/.test(lines[i])
          && !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
          && !/^\s*>\s?/.test(lines[i])
          && !/^(\s*)(?:[-*+]|\d+\.)\s+/.test(lines[i])
        ) {
          pLines.push(lines[i]);
          i += 1;
        }
        blocks.push({ type: 'paragraph', text: pLines.join('\n') });
      }
      return blocks;
    }

    function RichMarkdown({ text, phase }) {
      const normalized = React.useMemo(() => normalizeMessageMarkdown(text, phase), [text, phase]);
      const blocks = React.useMemo(() => parseMarkdownBlocks(normalized.markdown), [normalized.markdown]);
      return h('div', { className: 'mtr-md' },
        blocks.map((b, idx) => {
          const key = 'b-' + idx;
          if (b.type === 'code') return h(CodeFenceBlock, { key, language: b.lang, code: b.code });
          if (b.type === 'hr') return h('hr', { key });
          if (b.type === 'heading') return h('h' + b.level, { key }, renderInlineMarkdown(b.text, key));
          if (b.type === 'quote') return h('blockquote', { key }, renderInlineMarkdown(b.text, key));
          if (b.type === 'table') {
            return h('div', { key, className: 'mtr-table-wrap' },
              h('table', { className: 'mtr-table' },
                h('thead', null, h('tr', null, b.header.map((cell, ci) => h('th', { key: ci }, renderInlineMarkdown(cell, key + 'th' + ci))))),
                h('tbody', null, b.rows.map((row, ri) => h('tr', { key: ri }, row.map((cell, ci) => h('td', { key: ci }, renderInlineMarkdown(cell, key + 'td' + ri + '-' + ci))))))));
          }
          if (b.type === 'list') {
            const tag = b.ordered ? 'ol' : 'ul';
            return h(tag, { key, ...(b.ordered && b.start > 1 ? { start: b.start } : {}) },
              b.items.map((item, li) => h('li', { key: li },
                item.checked !== null && h('input', { type: 'checkbox', checked: item.checked, disabled: true, readOnly: true, style: { marginRight: 6 } }),
                renderInlineMarkdown(item.text, key + 'li' + li))));
          }
          return h('p', { key }, renderInlineMarkdown(b.text, key));
        }),
        normalized.rawJson && h('details', { className: 'mtr-raw-json' },
          h('summary', null, '查看原始 JSON'),
          h(CodeFenceBlock, { language: 'json', code: normalized.rawJson })));
    }

    function describeReviewState(task, workflow, ambiguityHint, needsPermConfirm) {
      if (needsPermConfirm || workflow?.state === 'permission-blocked') {
        return {
          badge: '🔒 权限待确认',
          summary: workflow?.error || '当前工单需要更高执行权限，请确认授权后继续运行。',
        };
      }
      if (ambiguityHint) {
        return {
          badge: '📝 需求待明确',
          summary: ambiguityHint,
        };
      }
      if (workflow?.state === 'review-blocked' || task?.reviewReason === 'review-blocked' || workflow?.reviewReason === 'review-blocked') {
        return {
          badge: '⚖️ 审查待裁决',
          summary: workflow?.reviewSummary || task?.reviewSummary || '审查阶段发现需求边界或实现分歧，请给出裁决意见后继续执行，或直接拍板通过。',
        };
      }
      return {
        badge: '✅ 交付待验收',
        summary: workflow?.reviewSummary || task?.reviewSummary || '当前批次已执行完毕，请查阅交付报告或工单群记录后确认完成，或输入补充意见继续修正。',
      };
    }

    function TaskReviewReport({ taskId, development }) {
      const [report, setReport] = React.useState('');
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(false);
      React.useEffect(() => { ensureTaskRoomStyles(); }, []);
      const load = async event => {
        if (!event.currentTarget.open || report || loading) return;
        setLoading(true);
        setError('');
        try {
          const data = await fetchJson('marshal/tasks/report?taskId=' + encodeURIComponent(taskId), undefined, true);
          setReport(data.report);
        }
        catch (e) { setError(e.code === 'report-not-found' ? '该工作区报告已不可用。' : String(e.message || e)); }
        finally { setLoading(false); }
      };
      return h('details', { onToggle: load },
        h('summary', { style: { cursor: 'pointer', fontWeight: 600, fontSize: 12 } }, development ? '📄 查看开发交付报告' : '📄 查看审查报告'),
        loading && h('p', { style: uiMuted }, '读取中…'),
        error && h('p', { role: 'alert' }, error),
        report && h('div', { style: { marginTop: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid ' + dswTheme.border, background: dswTheme.layer } },
          h(RichMarkdown, { text: report })));
    }

