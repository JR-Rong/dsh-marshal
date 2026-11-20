import { mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { MemoryStore } from '../plugin-build/lib/src/memory/sqlite-store.js';
import { createMnemonNative } from '../plugin-build/lib/src/memory/mnemon-native.js';

const data = [
    ['任务群归档', '工单关单后保留完整群聊，重试和改派沿用同一个群，按运行批次追溯。', '工单群归档', '任务结束后还能翻看原来所有对话吗'],
    ['工单补丁验收', '独立审查以冻结的 Git 补丁和 SHA-256 为准，Coder 在隔离工作树里编码。', 'Git 补丁', '审查开发交付时以什么代码快照为依据'],
    ['公网故障排查', '先检查公网域名解析和网关握手，遇到证书链不全则补齐中间证书。', '证书链不全', '外部访问 TLS 提示信任失败先排查哪里'],
    ['记忆工作区隔离', '工作区公共记忆按 workspaceId 隔离，只有授权工作区成员可读取交接。', '工作区公共记忆', '别的项目的人能查到我们交接班记录吗'],
    ['机主审批', '全局记忆先提交候选提案，机主审批后才生效，同时标记群聊和单聊可见性。', '全局记忆审批', '如何让某条长期规则分享给所有会话'],
    ['报表金额口径', '每周经营报表以已签收订单计算成交额，退款金额在下一统计周期单列。', '已签收订单', '周报的收入合计应该用什么订单状态'],
    ['续约计费约定', '续约客户按原合同年付周期计费，财务系统的账单月份使用北京时间。', '原合同年付', '老客户延长合同以后是每个月付吗'],
    ['发布缓存策略', '发布后仅清理临时构建缓存，业务报表中间文件保留七天。', '临时构建缓存', '每次上线能不能顺便把财务的中间产物都删掉'],
    ['生产日志留档', '生产重启前导出最近一小时错误日志，再把部署提交号记入值班记录。', '错误日志', '线上服务要重新拉起来，运维先保留哪些故障证据'],
    ['供应商尽调', '调研材料优先使用厂商原始规格页，并保存版本、时间和引用链接。', '厂商原始规格页', '技术选型从什么地方找参数比较靠谱'],
    ['移动端离线回放', '原设备离线时，跨设备工单群在 Hub 读取，正文按记录序号完整分页。', '原设备离线', '负责开发的那台电脑关机以后怎么找聊天历史'],
    ['中文展示规范', 'UI 标点使用中文全角，函数名和外部协议字段保持原文。', '中文全角', '界面里括号和协议字段的文本规则是什么'],
];
const distractors = [
    ['发布环境记录', '部署提交号发布后写工单，镜像构建缓存可加速持续集成。'],
    ['工单席位联动', '工单群的角色设置支持暂存，跨设备音频聊天由桌面运行时提供。'],
    ['退款统计', '退款率统计已经支付的订单数，取消订单由客服报表单独处理。'],
    ['开发环境', '开发工作区绑定 Git 仓库，二次重试使用新的运行批次。'],
    ['支持交接', '外部访问失败时交接客服，配置证书有效期和告警消息。'],
    ['缓存过期日志', '本机日志缓存压缩归档，留存系统会对缓存实施定期轮替。'],
    ['调研记录格式', '调研来源链接需要聚合到知识库，测试原始音视频要保留。'],
    ['桌面注销账号', '退出桌面账号保留本机授权，重新登录后能查看审批历史。'],
    ['见习术语约定', '本机代码协议字段名沿用英文，可在 README 补充中文释义。'],
    ['统计周期切换', '财务记账周期跨月时，月末按本地账单时区处理。'],
    ['部署审查', '生产部署使用签名镜像，发布验收通过后生成单独的交付报告。'],
    ['工作区状态', '工作区权限撤销后重启客户端，当前任务已归档时只允许读取。'],
];
const executable = process.argv[2];
if (!executable || !isAbsolute(executable)) throw new Error('Pass the absolute path to the Mnemon Native executable.');
const root = mkdtempSync(join(tmpdir(), 'marshal-mnemon-bench-'));
const scope = { scope: 'agent', ownerId: 'pilot-zh' };
const native = createMnemonNative({ root, agentId: scope.ownerId, executable });
const sqlite = new MemoryStore({ root });
try {
    for (const [title, content] of [...data, ...distractors]) {
        const entry = { kind: 'fact', title, content, importance: 0.7 };
        sqlite.remember(scope.scope, scope.ownerId, entry);
        await native.remember(entry);
    }
    const cases = data.flatMap(([title,, exact, paraphrase]) => [{ title, query: exact, set: 'keyword' }, { title, query: paraphrase, set: 'paraphrase' }]);
    const backends = { sqlite: query => sqlite.recall([scope], query, { k: 3 }), mnemon: query => native.recall(query, { k: 3 }) };
    const outputs = {};
    for (const [name, recall] of Object.entries(backends)) {
        const hit = {};
        for (const test of cases) {
            const items = await recall(test.query);
            const position = items.findIndex(item => item.title === test.title) + 1;
            (hit[test.set] ??= []).push({ position, query: test.query, first: items[0]?.title });
        }
        const times = [];
        for (let pass = 0; pass < 6; pass++) for (const {query} of cases) {
            const start = performance.now();
            await recall(query);
            times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        const count = (entries, k) => entries.filter(row => row.position > 0 && row.position <= k).length;
        outputs[name] = { corpus: data.length + distractors.length, samples: times.length,
            p50: times[Math.ceil(times.length * 0.5)-1].toFixed(2), p95: times[Math.ceil(times.length * 0.95)-1].toFixed(2),
            quality: Object.fromEntries(Object.entries(hit).map(([set, entries])=>[set,
                { total: entries.length, rank1: count(entries,1), rank3: count(entries,3), misses:entries.filter(row=>row.position===0).map(row=>row.query) }])),
        };
    }
    console.log(JSON.stringify(outputs, null, 2));
} finally {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
}
