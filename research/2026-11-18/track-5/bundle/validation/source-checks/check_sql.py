"""Offline SQLite evaluation of exact source expressions with invented rows.
This does not execute the Go daemon, API handlers or provider billing APIs.
"""
from pathlib import Path
import hashlib,json,sqlite3,sys

BASE=Path(__file__).resolve().parent
provenance=json.loads((BASE/'provenance.json').read_text())
source_bytes=(BASE/'sql-evidence.json').read_bytes()
assert hashlib.sha256(source_bytes).hexdigest()==provenance['snippet_files']['sql-evidence.json']
evidence=json.loads(source_bytes)
db=sqlite3.connect(':memory:')
db.executescript(evidence['usage_event_ddl']+'\n'+evidence['file_annotation_ddl'])
db.executemany('INSERT INTO usage_event(id,ts,machine_id,source,vendor,model,input,output,cost,gen_tps,request_id,product) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[
 ('synthetic-1',1000,'synthetic-machine','meter','synthetic-provider','synthetic-model',50,50,0,50,'synthetic-request-1','sniffed-tool'),
 ('synthetic-2',1001,'synthetic-machine','meter','synthetic-provider','synthetic-model',50,50,0,None,'synthetic-request-2','sniffed-tool')])
db.execute('INSERT INTO file_annotation(vendor,request_id,product,cost,ts) VALUES(?,?,?,?,?)',('synthetic-provider','synthetic-request-1','annotated-tool',.25,1000))

# Faithful minimal reduction of aggregate alias resolution: actual aggregate
# queries omit annotationJoinSQL. Unrelated joins cannot define alias fa.
# Their exact Go query/argument context is retained in sql-evidence.json.
try:
    db.execute('SELECT '+evidence['raw_cost_expression']+' FROM usage_event WHERE '+evidence['product_filter_predicate'],('annotated-tool',)).fetchall()
    product_error=None
except sqlite3.OperationalError as exc:
    product_error=str(exc)
assert product_error=='no such column: fa.product'

source_avg=db.execute('SELECT '+evidence['generation_rate_expression']+' FROM usage_event').fetchone()[0]
supported_avg=db.execute('SELECT SUM(gen_tps*(output+input))/NULLIF(SUM(output+input),0) FROM usage_event WHERE gen_tps IS NOT NULL').fetchone()[0]
raw_cost=db.execute('SELECT '+evidence['raw_cost_expression']+' FROM usage_event').fetchone()[0]
# This comparator is authored harness SQL equivalent to the included Go
# branch: non-null file cost wins, otherwise raw cost. It is not a claimed
# verbatim repository SQL expression or a completed code repair.
effective_cost=db.execute('SELECT SUM(COALESCE(fa.cost,usage_event.cost)) FROM usage_event '+evidence['annotation_join']).fetchone()[0]
assert source_avg==25.0 and supported_avg==50.0
assert raw_cost==0.0 and effective_cost==.25
result={
 'test_scope':'Offline synthetic SQLite source-expression reproduction only; Go daemon/API unexecuted',
 'commit':provenance['commit'],
 'runtime':{'python':sys.version.split()[0],'sqlite':sqlite3.sqlite_version},
 'product_tool_filter_missing_annotation_join':product_error,
 'source_generation_rate_average':source_avg,
 'supported_observations_only_average':supported_avg,
 'source_aggregate_raw_cost':raw_cost,
 'effective_event_cost_sum':effective_cost,
 'reported_cost_meaning':'Invented tool/file annotation; not a provider billing API, invoice or payment',
 'product_meaning':'Tool/product attribution, not an organizational project ID',
 'checks':'PASS — audited behavior reproduced; not a fixed implementation or production release test'
}
db.close()
text=json.dumps(result,indent=2)+'\n'
(BASE/'sql-results.json').write_text(text)
print(text,end='')
