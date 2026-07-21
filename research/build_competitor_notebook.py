from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT_PATH = ROOT / "competitor-research.ipynb"


def markdown(source):
    return {"cell_type": "markdown", "metadata": {}, "source": source.splitlines(keepends=True)}


def code(source, execution_count, namespace):
    buffer = StringIO()
    with redirect_stdout(buffer):
        exec(source, namespace)
    output = buffer.getvalue()
    outputs = []
    if output:
        outputs.append({"name": "stdout", "output_type": "stream", "text": output.splitlines(keepends=True)})
    return {
        "cell_type": "code",
        "execution_count": execution_count,
        "metadata": {},
        "outputs": outputs,
        "source": source.splitlines(keepends=True),
    }


namespace = {"__file__": str(ROOT / "competitor-research.ipynb")}
cells = [
    markdown("""## tl;dr

- 样本覆盖 13 个代表产品、10 个能力维度；评分用于比较官网可证实的能力覆盖，不代表产品质量或市场份额。
- `2` = 官网证实为核心/完整能力，`1` = 部分覆盖或通用能力，`0` = 本轮公开资料未证实。
- 结论应与配套研究报告一起阅读；矩阵是可复算的证据层，不替代产品实测。
"""),
    markdown("""## Context & Methods

目标：判断 ContentFerry 不应在哪些成熟能力上重复竞争，以及哪些能力组合仍有差异化空间。

### Key Assumptions

- 截止日期：2026-07-16。
- 样本为目的性抽样，覆盖国内矩阵工具、公众号工具、海外社媒套件、AI 营销平台和通用 Agent/自动化平台，不用于估算市场份额。
- 仅依据官网、官方帮助中心、官方仓库与官方发布信息；没有公开证据不等于产品一定不具备该能力。
- “本地/自托管”按产品运行与数据控制能力评分，不把普通桌面客户端自动视为完整本地优先。
"""),
    markdown("## Data\n\n读取人工核验后的能力矩阵，并保留产品类别与来源链接。\n"),
]

cell_sources = [
    """from pathlib import Path
import pandas as pd

csv_path = Path.cwd() / 'competitor-capability-matrix.csv'
if not csv_path.exists():
    csv_path = Path.cwd() / 'research' / 'competitor-capability-matrix.csv'

df = pd.read_csv(csv_path)
capability_columns = [
    'research_hotspots', 'ai_creation', 'brand_context', 'platform_adaptation',
    'multi_account_publishing', 'approval_governance', 'quality_compliance',
    'analytics_inbox', 'agent_workflows', 'local_self_host'
]

assert len(df) == 13
assert df['product'].is_unique
assert df[capability_columns].isin([0, 1, 2]).all().all()
print(df[['product', 'region', 'archetype', *capability_columns]].to_string(index=False))
""",
    """capability_labels = {
    'research_hotspots': '研究/热点',
    'ai_creation': 'AI创作',
    'brand_context': '品牌/人设上下文',
    'platform_adaptation': '平台适配',
    'multi_account_publishing': '多账号发布',
    'approval_governance': '审批/治理',
    'quality_compliance': '质量/合规',
    'analytics_inbox': '分析/收件箱',
    'agent_workflows': 'Agent/工作流',
    'local_self_host': '本地/自托管',
}

coverage = pd.DataFrame({
    'capability': [capability_labels[c] for c in capability_columns],
    'core_count': [(df[c] == 2).sum() for c in capability_columns],
    'partial_count': [(df[c] == 1).sum() for c in capability_columns],
    'not_evidenced_count': [(df[c] == 0).sum() for c in capability_columns],
})
coverage['covered_count'] = coverage['core_count'] + coverage['partial_count']
coverage['coverage_rate'] = coverage['covered_count'] / len(df)
coverage = coverage.sort_values(['coverage_rate', 'core_count'], ascending=False).reset_index(drop=True)
print(coverage.to_string(index=False))
""",
    """archetype_profile = (
    df.groupby('archetype')[capability_columns]
      .mean()
      .rename(columns=capability_labels)
      .round(2)
)
print(archetype_profile.to_string())
""",
    """bundles = {
    '创作+发布': ['ai_creation', 'multi_account_publishing'],
    '发布+审批+分析': ['multi_account_publishing', 'approval_governance', 'analytics_inbox'],
    '品牌上下文+Agent工作流': ['brand_context', 'agent_workflows'],
    '研究+质量+发布': ['research_hotspots', 'quality_compliance', 'multi_account_publishing'],
    '审批+Agent+本地': ['approval_governance', 'agent_workflows', 'local_self_host'],
}

bundle_rows = []
for label, cols in bundles.items():
    matched = df.loc[(df[cols] == 2).all(axis=1), 'product'].tolist()
    bundle_rows.append({'bundle': label, 'core_match_count': len(matched), 'products': '、'.join(matched) or '无'})

bundle_df = pd.DataFrame(bundle_rows)
print(bundle_df.to_string(index=False))
""",
]

cells.append(code(cell_sources[0], 1, namespace))
cells.append(markdown("## Results\n\n先看各能力在样本中的覆盖广度，再看不同产品类别的结构性强弱。\n"))
for execution_count, source in enumerate(cell_sources[1:], start=2):
    cells.append(code(source, execution_count, namespace))

cells.append(markdown("""## Takeaways

- AI 创作、平台适配、多账号发布、审批和分析都已有成熟供给，单点功能很难形成护城河。
- 品牌/人设上下文主要被 Jasper、Copy.ai 等营销平台做深；国内矩阵工具普遍较弱。
- 本地/自托管主要出现在 Dify、n8n 等通用平台，但它们不提供中文自媒体的领域闭环。
- “研究 → 有来源写作 → 质量/合规 → 人工审核 → 指定账号发布 → 结果回收”的完整组合在样本中没有直接同类。
- 最值得验证的不是更多平台数量，而是：可追溯内容工程、风险自适应审核、失败可恢复的浏览器技能，以及本地 Markdown/Agent 工作流。
"""))

notebook = {
    "cells": cells,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3"},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}

OUTPUT_PATH.write_text(json.dumps(notebook, ensure_ascii=False, indent=1), encoding="utf-8")
print(OUTPUT_PATH)
