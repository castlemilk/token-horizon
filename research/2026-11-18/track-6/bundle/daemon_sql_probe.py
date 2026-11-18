#!/usr/bin/env python3
"""Standalone synthetic reproduction of Token Horizon Go daemon SQL expressions.

Public source: castlemilk/token-horizon main,
b468206e9378c8d7a6788b67072494982e7de17d, inspected 2026-11-18.
Query expressions and annotation join are extracted from:
  daemons/go/internal/store/schema.go
  daemons/go/internal/store/query.go
The minimal schema below is an isolated synthetic reproduction of needed columns.
No network, no file database, no user data, and no Go service are used.
Run: python3 daemon_sql_probe.py
This establishes behavior of isolated SQLite expressions, not deployment state.
"""
import json
import sqlite3

SCHEMA = """
CREATE TABLE usage_event (
 id TEXT PRIMARY KEY, ts INTEGER, machine_id TEXT, source TEXT,
 vendor TEXT, model TEXT, input INTEGER, output INTEGER,
 gen_tps REAL, context_occupancy INTEGER, cost REAL,
 request_id TEXT, request_id_alt TEXT, product_source TEXT, product TEXT
);
CREATE TABLE file_annotation (
 vendor TEXT, request_id TEXT, product TEXT, cost REAL, ts INTEGER
);
"""
ANNOTATION_JOIN = '\nLEFT JOIN file_annotation fa ON fa.rowid = (\n    SELECT MIN(rowid) FROM file_annotation\n    WHERE request_id = usage_event.request_id\n       OR request_id = usage_event.request_id_alt\n)'

def main():
    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)
    insert = """INSERT INTO usage_event
        (id,ts,machine_id,source,vendor,model,input,output,gen_tps,
         context_occupancy,cost,request_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"""
    db.executemany(insert, [
        ("synthetic-a",1,"synthetic-device","external","openai","synthetic-model",100,50,10,100,0,"synthetic-rid"),
        ("synthetic-b",2,"synthetic-device","external","openai","synthetic-model",100,50,None,None,0,"synthetic-rid-b"),
    ])
    # Exact source expressions from query.go Summary(), lines 296 and 298.
    averages = db.execute("""SELECT
        SUM(usage_event.gen_tps * (usage_event.output+usage_event.input)) / NULLIF(SUM(usage_event.output+usage_event.input),0),
        SUM(usage_event.context_occupancy * (usage_event.output+usage_event.input)) / NULLIF(SUM(usage_event.output+usage_event.input),0)
        FROM usage_event""").fetchone()
    db.execute("""INSERT INTO file_annotation
        (vendor,request_id,product,cost,ts) VALUES (?,?,?,?,?)""",
        ("different-vendor","synthetic-rid","synthetic-foreign-tool",2.0,1))
    joined = db.execute("""SELECT usage_event.id,fa.product,fa.cost,usage_event.cost
        FROM usage_event """ + ANNOTATION_JOIN + " WHERE usage_event.id=?", ("synthetic-a",)).fetchone()
    # Both Buckets and Summary lack annotationJoinSQL, although Filter.where()
    # produces this exact predicate whenever Product is nonempty.
    product_predicate = """COALESCE(CASE WHEN usage_event.product_source = 'explicitLabel' THEN usage_event.product END, fa.product, usage_event.product) = ?"""
    try:
        db.execute("SELECT SUM(usage_event.cost) FROM usage_event WHERE " + product_predicate,
                   ("synthetic-tool",)).fetchone()
        product_filter = "unexpected success"
    except sqlite3.OperationalError as error:
        product_filter = str(error)
    result = {
        "scope": "Standalone in-memory SQLite reproduction of exact source SQL expressions at b468206e9378c8d7a6788b67072494982e7de17d; all rows synthetic; not a daemon execution or production measurement",
        "weighted_average_with_one_missing_observation": {
            "actual_gen_tps": averages[0], "actual_context_occupancy": averages[1],
            "observed_only_gen_tps": 10, "observed_only_context": 100,
        },
        "cross_vendor_request_id_annotation_join": {
            "row": joined[0], "joined_product": joined[1],
            "event_effective_cost": joined[2], "aggregate_raw_cost": joined[3],
        },
        "product_filter_without_annotation_join": product_filter,
    }
    assert averages == (5.0,50), averages
    assert joined == ("synthetic-a","synthetic-foreign-tool",2.0,0.0), joined
    assert product_filter == "no such column: fa.product", product_filter
    db.close()
    print(json.dumps(result,indent=2))

if __name__ == "__main__":
    main()
