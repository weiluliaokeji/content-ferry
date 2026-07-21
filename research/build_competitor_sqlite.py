import csv
import json
from pathlib import Path
import sqlite3


ROOT = Path(__file__).resolve().parent
CSV_PATH = ROOT / "competitor-capability-matrix.csv"
DB_PATH = ROOT / "competitor-research.sqlite"
RESULT_PATH = ROOT / "competitor-query-results.json"

capabilities = [
    ("research_hotspots", "研究/热点"),
    ("ai_creation", "AI创作"),
    ("brand_context", "品牌/人设上下文"),
    ("platform_adaptation", "平台适配"),
    ("multi_account_publishing", "多账号发布"),
    ("approval_governance", "审批/治理"),
    ("quality_compliance", "质量/合规"),
    ("analytics_inbox", "分析/收件箱"),
    ("agent_workflows", "Agent/工作流"),
    ("local_self_host", "本地/自托管"),
]

coverage_sql = "\nUNION ALL\n".join(
    f"""SELECT '{label}' AS capability,
       SUM(CASE WHEN {column} = 2 THEN 1 ELSE 0 END) AS core_count,
       SUM(CASE WHEN {column} = 1 THEN 1 ELSE 0 END) AS partial_count,
       SUM(CASE WHEN {column} = 0 THEN 1 ELSE 0 END) AS not_evidenced_count,
       SUM(CASE WHEN {column} >= 1 THEN 1 ELSE 0 END) AS covered_count,
       AVG(CASE WHEN {column} >= 1 THEN 1.0 ELSE 0.0 END) AS coverage_rate
FROM competitor_scores"""
    for column, label in capabilities
)

bundle_sql = """SELECT '创作 + 发布' AS bundle, COUNT(*) AS core_match_count,
       COALESCE(GROUP_CONCAT(product, '、'), '无') AS products
FROM competitor_scores WHERE ai_creation = 2 AND multi_account_publishing = 2
UNION ALL
SELECT '发布 + 审批 + 分析', COUNT(*), COALESCE(GROUP_CONCAT(product, '、'), '无')
FROM competitor_scores WHERE multi_account_publishing = 2 AND approval_governance = 2 AND analytics_inbox = 2
UNION ALL
SELECT '品牌上下文 + Agent工作流', COUNT(*), COALESCE(GROUP_CONCAT(product, '、'), '无')
FROM competitor_scores WHERE brand_context = 2 AND agent_workflows = 2
UNION ALL
SELECT '研究 + 质量 + 发布', COUNT(*), COALESCE(GROUP_CONCAT(product, '、'), '无')
FROM competitor_scores WHERE research_hotspots = 2 AND quality_compliance = 2 AND multi_account_publishing = 2
UNION ALL
SELECT '审批 + Agent + 本地', COUNT(*), COALESCE(GROUP_CONCAT(product, '、'), '无')
FROM competitor_scores WHERE approval_governance = 2 AND agent_workflows = 2 AND local_self_host = 2"""

sample_sql = """SELECT product, region, archetype,
       research_hotspots + ai_creation + brand_context + platform_adaptation +
       multi_account_publishing + approval_governance + quality_compliance +
       analytics_inbox + agent_workflows + local_self_host AS total_score,
       source_urls AS source_url
FROM competitor_scores
ORDER BY total_score DESC, product"""


def rows(cursor, sql):
    result = cursor.execute(sql)
    columns = [item[0] for item in result.description]
    return [dict(zip(columns, row)) for row in result.fetchall()]


with CSV_PATH.open("r", encoding="utf-8-sig", newline="") as handle:
    input_rows = list(csv.DictReader(handle))

integer_columns = [column for column, _ in capabilities]
for row in input_rows:
    for column in integer_columns:
        row[column] = int(row[column])

if DB_PATH.exists():
    DB_PATH.unlink()

connection = sqlite3.connect(DB_PATH)
cursor = connection.cursor()
cursor.execute(
    """CREATE TABLE competitor_scores (
        product TEXT PRIMARY KEY, region TEXT, archetype TEXT,
        research_hotspots INTEGER, ai_creation INTEGER, brand_context INTEGER,
        platform_adaptation INTEGER, multi_account_publishing INTEGER,
        approval_governance INTEGER, quality_compliance INTEGER,
        analytics_inbox INTEGER, agent_workflows INTEGER, local_self_host INTEGER,
        source_urls TEXT
    )"""
)
columns = list(input_rows[0].keys())
cursor.executemany(
    f"INSERT INTO competitor_scores ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
    [[row[column] for column in columns] for row in input_rows],
)
connection.commit()

payload = {
    "coverage_sql": coverage_sql,
    "coverage": rows(cursor, coverage_sql),
    "bundle_sql": bundle_sql,
    "bundles": rows(cursor, bundle_sql),
    "sample_sql": sample_sql,
    "competitors": rows(cursor, sample_sql),
}
connection.close()

RESULT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
print(DB_PATH)
print(RESULT_PATH)
