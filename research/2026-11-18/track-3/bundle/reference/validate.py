#!/usr/bin/env python3
"""Synthetic SQLite evidence graph experiment. No network or production imports."""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import platform
import re
import sqlite3
import time
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NODE_COLUMNS = ("workspace_id", "version_id", "logical_id", "kind", "title", "body",
                "valid_from", "valid_to", "recorded_from", "recorded_to")
EDGE_COLUMNS = ("workspace_id", "edge_id", "relation", "from_version_id", "to_version_id",
                "valid_from", "valid_to", "recorded_from", "recorded_to")
MAX_SUPPORT_DEPTH = 12
MAX_FIXTURE_NODES = 500
MAX_FIXTURE_EDGES = 1000


def expect_error(kind, action):
    try:
        action()
    except kind:
        return
    raise AssertionError(f"Expected {kind.__name__}")


class Reference:
    """Trusted local fixture API. Its subject argument is NOT an auth mechanism."""
    def __init__(self):
        self.fixture = json.loads((ROOT / "fixture.json").read_text())
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript((ROOT / "schema.sql").read_text())
        self.cache = {}
        self.valid_at = self.fixture["cutoff"]["valid_at"]
        self.known_at = self.fixture["cutoff"]["known_at"]
        self.load_fixture()

    def load_fixture(self):
        for workspace in self.fixture["workspaces"]:
            ws = workspace["workspace_id"]
            self.db.execute("INSERT INTO kg_workspace VALUES (?,1,1)", (ws,))
            for member in workspace["members"]:
                subject = member["subject_id"]
                self.db.execute("INSERT INTO kg_member VALUES (?,?,?,1)",
                                (ws, subject, member["role"]))
                for permission in ("read", "export", "erase"):
                    self.db.executemany("INSERT INTO kg_grant VALUES (?,?,?,?)",
                        [(ws, subject, scope, permission) for scope in member.get(permission,[])])
            for public in workspace["public_team_members"]:
                self.db.execute("INSERT INTO kg_public_team_member VALUES (?,?,?)",
                                (ws, public["team_id"], public["subject_id"]))
        for node in self.fixture["nodes"]:
            self.insert_node(node)
        for evidence in self.fixture["supports"]:
            for source in evidence["source_version_ids"]:
                self.db.execute("INSERT INTO kg_node_evidence VALUES (?,?,?)",
                    (evidence["workspace_id"], evidence["assertion_version_id"], source))
        for edge in self.fixture["edges"]:
            self.insert_edge(edge)
        for dependency in self.fixture["dependencies"]:
            self.db.execute("INSERT INTO kg_dependency VALUES (?,?,?)",
                (dependency["workspace_id"], dependency["upstream_version_id"],
                 dependency["downstream_version_id"]))
        fan = self.fixture["generated_fanout"]
        for index in range(fan["count"]):
            version = f"fan-{index:03}"
            self.insert_node({
                "workspace_id": fan["workspace_id"], "version_id": version,
                "logical_id": version, "kind": "ContextItem", "title": version,
                "body": "Synthetic fanout row.", "scopes": [fan["scope_id"]]})
            self.db.execute("INSERT INTO kg_node_evidence VALUES (?,?,?)",
                (fan["workspace_id"], version, fan["source_version_id"]))
            self.insert_edge({
                "workspace_id": fan["workspace_id"], "edge_id": "edge-" + version,
                "relation": "context", "from_version_id": fan["project_version_id"],
                "to_version_id": version, "scopes": [fan["scope_id"]],
                "source_version_ids": [fan["source_version_id"]]})
        assert self.count("kg_node_version") <= MAX_FIXTURE_NODES
        assert self.count("kg_edge_version") <= MAX_FIXTURE_EDGES
        self.db.commit()

    def count(self, table):
        # All callers below use fixed source-code constants, never user input.
        assert table in {"kg_node_version", "kg_edge_version", "kg_fts", "kg_tombstone"}
        return self.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0]

    def _normalized(self, item, columns):
        row = {**self.fixture["defaults"], **item}
        for field in ("valid_from", "valid_to", "recorded_from", "recorded_to"):
            value = row.get(field)
            if value is not None:
                assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value)
                dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return tuple(row.get(column) for column in columns)

    def _tombstoned(self, ws, kind, resource):
        return self.db.execute("SELECT 1 FROM kg_tombstone WHERE workspace_id=? "
            "AND resource_kind=? AND resource_id=?", (ws, kind, resource)).fetchone() is not None

    def insert_node(self, item):
        ws, version = item["workspace_id"], item["version_id"]
        if self._tombstoned(ws, "node", version):
            raise ValueError("tombstoned version cannot be replayed")
        assert len(item["title"].encode()) <= 512 and len(item.get("body", "").encode()) <= 8192
        values = self._normalized({**item, "body": item.get("body", "")}, NODE_COLUMNS)
        existing = self.db.execute("SELECT * FROM kg_node_version "
            "WHERE workspace_id=? AND version_id=?", (ws, version)).fetchone()
        scopes = sorted(set(item["scopes"]))
        if existing:
            stored_scopes = sorted(self.node_scopes(ws, version))
            if tuple(existing) != values or stored_scopes != scopes:
                raise ValueError("same version ID with different payload")
            return False  # Does not reset current source lifecycle on replay.
        if self.count("kg_node_version") >= MAX_FIXTURE_NODES:
            raise ValueError("toy fixture node budget exceeded")
        self.db.execute("INSERT INTO kg_node_version VALUES (?,?,?,?,?,?,?,?,?,?)", values)
        self.db.executemany("INSERT INTO kg_node_scope VALUES (?,?,?)",
                            [(ws, version, scope) for scope in scopes])
        if item["kind"] == "SourceRevision":
            self.db.execute("INSERT INTO kg_source_state VALUES (?,?,?)",
                            (ws, version, item["source_state"]))
        self.db.execute("INSERT INTO kg_fts VALUES (?,?,?,?)",
                        (ws, version, item["title"], item.get("body", "")))
        return True

    def insert_edge(self, item):
        ws, edge = item["workspace_id"], item["edge_id"]
        if self._tombstoned(ws, "edge", edge):
            raise ValueError("tombstoned edge cannot be replayed")
        if self.count("kg_edge_version") >= MAX_FIXTURE_EDGES:
            raise ValueError("toy fixture edge budget exceeded")
        values = self._normalized(item, EDGE_COLUMNS)
        self.db.execute("INSERT INTO kg_edge_version VALUES (?,?,?,?,?,?,?,?,?)", values)
        self.db.executemany("INSERT INTO kg_edge_scope VALUES (?,?,?)",
                            [(ws, edge, scope) for scope in set(item["scopes"])])
        self.db.executemany("INSERT INTO kg_edge_evidence VALUES (?,?,?)",
                            [(ws, edge, source) for source in set(item["source_version_ids"])])

    def epoch(self, ws):
        row = self.db.execute("SELECT policy_epoch FROM kg_workspace WHERE workspace_id=?",
                              (ws,)).fetchone()
        return row[0] if row else None

    def bump_epoch(self, ws):
        self.db.execute("UPDATE kg_workspace SET policy_epoch=policy_epoch+1 WHERE workspace_id=?",
                        (ws,))

    def snapshot(self, ws):
        row=self.db.execute("SELECT policy_epoch,graph_revision FROM kg_workspace WHERE workspace_id=?",
                            (ws,)).fetchone()
        return tuple(row) if row else None

    def member(self, ws, subject, permission):
        member = self.db.execute("SELECT role,active FROM kg_member "
            "WHERE workspace_id=? AND subject_id=?", (ws, subject)).fetchone()
        return bool(member and member["active"] and
                    (permission != "erase" or member["role"] == "owner") and
                    (permission != "export" or member["role"] in {"owner", "editor"}))

    def node_scopes(self, ws, version):
        return {r[0] for r in self.db.execute("SELECT scope_id FROM kg_node_scope "
            "WHERE workspace_id=? AND version_id=?", (ws, version))}

    def scopes_allowed(self, ws, subject, scopes, permission):
        granted = {r[0] for r in self.db.execute("SELECT scope_id FROM kg_grant "
            "WHERE workspace_id=? AND subject_id=? AND permission=?", (ws, subject, permission))}
        if permission == "export":
            readable = {r[0] for r in self.db.execute("SELECT scope_id FROM kg_grant "
                "WHERE workspace_id=? AND subject_id=? AND permission='read'", (ws, subject))}
            granted &= readable
        return bool(scopes) and scopes <= granted  # Conjunction; empty fails closed.

    def temporal(self, row, valid_at, known_at, allow_unknown=False):
        if not (row["recorded_from"] <= known_at and
                (row["recorded_to"] is None or known_at < row["recorded_to"])):
            return False
        if row["valid_from"] is None:
            return allow_unknown
        return row["valid_from"] <= valid_at and (row["valid_to"] is None or valid_at < row["valid_to"])

    def dependencies(self, ws, version):
        return [r[0] for r in self.db.execute("SELECT upstream_version_id FROM kg_dependency "
            "WHERE workspace_id=? AND downstream_version_id=? UNION "
            "SELECT source_version_id FROM kg_node_evidence WHERE workspace_id=? "
            "AND assertion_version_id=? ORDER BY 1", (ws, version, ws, version))]

    def node_allowed(self, ws, subject, version, permission="read", valid_at=None,
                     known_at=None, allow_unknown=False, seen=frozenset()):
        valid_at, known_at = valid_at or self.valid_at, known_at or self.known_at
        if not self.member(ws, subject, permission) or version in seen or len(seen) >= MAX_SUPPORT_DEPTH:
            return False
        if self._tombstoned(ws, "node", version):
            return False
        row = self.db.execute("SELECT * FROM kg_node_version WHERE workspace_id=? AND version_id=?",
                              (ws, version)).fetchone()
        if not row or not self.temporal(row, valid_at, known_at, allow_unknown and permission=="read"):
            return False
        if not self.scopes_allowed(ws, subject, self.node_scopes(ws, version), permission):
            return False
        if row["kind"] == "SourceRevision":
            state = self.db.execute("SELECT state FROM kg_source_state "
                "WHERE workspace_id=? AND source_version_id=?", (ws, version)).fetchone()
            if not state or state[0] not in ({"active", "stale"} if permission=="read" else {"active"}):
                return False
        required = self.dependencies(ws, version)
        if not required:
            return row["kind"] == "SourceRevision"  # Raw sources can be terminal.
        return all(self.node_allowed(ws, subject, parent, permission, valid_at, known_at,
            allow_unknown, seen | {version}) for parent in required)

    def edge_allowed(self, ws, subject, edge, permission="read", valid_at=None, known_at=None):
        valid_at, known_at = valid_at or self.valid_at, known_at or self.known_at
        if not self.temporal(edge, valid_at, known_at):
            return False
        scopes = {r[0] for r in self.db.execute("SELECT scope_id FROM kg_edge_scope "
            "WHERE workspace_id=? AND edge_id=?", (ws, edge["edge_id"]))}
        sources = [r[0] for r in self.db.execute("SELECT source_version_id FROM kg_edge_evidence "
            "WHERE workspace_id=? AND edge_id=?", (ws, edge["edge_id"]))]
        return (bool(sources) and self.scopes_allowed(ws, subject, scopes, permission)
            and all(self.node_allowed(ws, subject, version, permission, valid_at, known_at)
                for version in [edge["from_version_id"], edge["to_version_id"], *sources]))

    def source_closure(self, ws, version):
        """Only called after authorization, and bounded by visited + fixture size."""
        pending, seen, sources, scopes = [version], set(), set(), set()
        while pending:
            item = pending.pop()
            if item in seen:
                continue
            seen.add(item)
            assert len(seen) <= MAX_FIXTURE_NODES
            scopes |= self.node_scopes(ws, item)
            row = self.db.execute("SELECT kind FROM kg_node_version "
                "WHERE workspace_id=? AND version_id=?", (ws, item)).fetchone()
            if row and row[0] == "SourceRevision":
                sources.add(item)
            pending.extend(self.dependencies(ws, item))
        return sorted(sources), sorted(scopes)

    def traverse(self, ws, subject, seed, max_depth=2, max_nodes=25, max_edges=40,
                 valid_at=None, known_at=None, max_vm_steps=2_000_000):
        if not (0 <= max_depth <= 4 and 1 <= max_nodes <= 100 and 1 <= max_edges <= 150
                and 1 <= max_vm_steps <= 2_000_000):
            raise ValueError("invalid traversal budget")
        valid_at, known_at = valid_at or self.valid_at, known_at or self.known_at
        calls = 0
        def budget():
            nonlocal calls
            calls += 1
            return calls * 100 > max_vm_steps
        self.db.set_progress_handler(budget, 100)
        try:
            if not self.node_allowed(ws, subject, seed, valid_at=valid_at, known_at=known_at):
                return {"status":"not_available","nodes":[],"edges":[],"paths":{}}
            queue, seen, edges, paths, cuts = deque([(seed, 0)]), {seed}, [], {seed:[seed]}, set()
            while queue:
                node, depth = queue.popleft()
                candidates = self.db.execute("SELECT * FROM kg_edge_version "
                    "WHERE workspace_id=? AND from_version_id=? ORDER BY edge_id", (ws, node))
                for edge in candidates:
                    if not self.edge_allowed(ws, subject, edge, valid_at=valid_at, known_at=known_at):
                        continue
                    target = edge["to_version_id"]
                    if depth >= max_depth:
                        cuts.add("depth")
                        continue
                    if len(edges) >= max_edges:
                        cuts.add("edges")
                        continue
                    if target not in seen and len(seen) >= max_nodes:
                        cuts.add("nodes")
                        continue
                    edges.append(edge["edge_id"])
                    if target not in seen:
                        seen.add(target)
                        paths[target] = paths[node] + [target]
                        queue.append((target, depth+1))
            node_evidence={version:self.source_closure(ws,version)[0] for version in sorted(seen)}
            edge_evidence={edge_id:[r[0] for r in self.db.execute(
                "SELECT source_version_id FROM kg_edge_evidence WHERE workspace_id=? "
                "AND edge_id=? ORDER BY source_version_id", (ws,edge_id))] for edge_id in edges}
            return {"status":"ok","nodes":sorted(seen),"edges":edges,"paths":paths,
                    "required_node_evidence":node_evidence,"required_edge_evidence":edge_evidence,
                    "visible_count":len(seen),"truncated":bool(cuts),
                    "truncation_reasons":sorted(cuts),
                    "limits":{"depth":max_depth,"nodes":max_nodes,"edges":max_edges}}
        except sqlite3.OperationalError as error:
            if "interrupt" not in str(error).lower():
                raise
            # No partial results on execution-budget failure.
            return {"status":"budget_exhausted","nodes":[],"edges":[],"paths":{}}
        finally:
            self.db.set_progress_handler(None, 0)

    def search(self, ws, subject, query, limit=10):
        if not 1 <= limit <= 25 or len(query) > 256:
            raise ValueError("invalid search budget")
        terms = re.findall(r"[A-Za-z0-9]+", query.lower())[:20]
        if not terms:
            return []
        # No bm25/global term frequencies: hidden documents must not affect rank.
        match = " OR ".join('"' + term.replace('"', '""') + '"' for term in terms)
        candidates = self.db.execute(
            "SELECT version_id FROM kg_fts WHERE workspace_id=? AND kg_fts MATCH ?",
            (ws, match))
        visible = []
        for candidate in candidates:
            version = candidate[0]
            if not self.node_allowed(ws, subject, version):
                continue
            row = self.db.execute("SELECT kind,title,body FROM kg_node_version "
                "WHERE workspace_id=? AND version_id=?", (ws, version)).fetchone()
            if row["kind"] != "ContextItem":
                continue
            tokens = re.findall(r"[A-Za-z0-9]+", (row["title"]+" "+row["body"]).lower())
            score = sum(tokens.count(term) for term in set(terms))
            visible.append({"version_id":version,"visible_term_count":score})
        return sorted(visible, key=lambda x:(-x["visible_term_count"],x["version_id"]))[:limit]

    def choose_revision(self, ws, subject, logical_id, valid_at, known_at):
        ids = [r[0] for r in self.db.execute("SELECT version_id FROM kg_node_version "
            "WHERE workspace_id=? AND logical_id=?", (ws, logical_id))]
        permitted = [x for x in ids if self.node_allowed(ws, subject, x,
                     valid_at=valid_at, known_at=known_at)]
        if len(permitted) > 1:
            raise ValueError("ambiguous valid/recorded intervals")
        return permitted[0] if permitted else None

    def export(self, ws, subject, versions, expected_snapshot, edge_ids=()):
        if not self.member(ws, subject, "export"):
            return {"status":"not_available","versions":[]}
        if expected_snapshot != self.snapshot(ws):
            return {"status":"stale_preview","versions":[]}
        if not versions or len(versions) > 25 or len(edge_ids) > 40 or not all(
                self.node_allowed(ws, subject, x, "export") for x in versions):
            return {"status":"not_available","versions":[]}
        sources = {s for x in versions for s in self.source_closure(ws, x)[0]}
        for edge_id in edge_ids:
            edge = self.db.execute("SELECT * FROM kg_edge_version WHERE workspace_id=? AND edge_id=?",
                                   (ws,edge_id)).fetchone()
            if (not edge or not self.edge_allowed(ws,subject,edge,"export") or
                not {edge["from_version_id"],edge["to_version_id"]} <= set(versions)):
                return {"status":"not_available","versions":[]}
            sources.update(r[0] for r in self.db.execute("SELECT source_version_id FROM kg_edge_evidence "
                            "WHERE workspace_id=? AND edge_id=?", (ws,edge_id)))
        return {"status":"ok","versions":list(versions),"required_source_versions":sorted(sources),
                "edge_versions":list(edge_ids),"policy_epoch":expected_snapshot[0],
                "graph_revision":expected_snapshot[1]}

    def save_cache(self, ws, subject, label, result):
        self.cache[(ws,subject,label)] = (self.snapshot(ws), copy.deepcopy(result))

    def read_cache(self, ws, subject, label):
        item = self.cache.get((ws,subject,label))
        if not item or item[0] != self.snapshot(ws) or not self.member(ws,subject,"read"):
            return None
        result = item[1]
        if not all(self.node_allowed(ws,subject,x) for x in result.get("nodes",[])):
            return None
        for edge_id in result.get("edges",[]):
            row = self.db.execute("SELECT * FROM kg_edge_version WHERE workspace_id=? AND edge_id=?",
                                  (ws,edge_id)).fetchone()
            if not row or not self.edge_allowed(ws,subject,row):
                return None
        return copy.deepcopy(result)

    def change_member(self, ws, subject, *, role=None, active=None):
        if role is not None:
            self.db.execute("UPDATE kg_member SET role=? WHERE workspace_id=? AND subject_id=?",
                            (role,ws,subject))
        if active is not None:
            self.db.execute("UPDATE kg_member SET active=? WHERE workspace_id=? AND subject_id=?",
                            (int(active),ws,subject))
        self.bump_epoch(ws)

    def revoke_grant(self, ws, subject, scope, permission):
        self.db.execute("DELETE FROM kg_grant WHERE workspace_id=? AND subject_id=? "
                        "AND scope_id=? AND permission=?", (ws,subject,scope,permission))
        self.bump_epoch(ws)

    def source_state(self, ws, source, state):
        self.db.execute("UPDATE kg_source_state SET state=? WHERE workspace_id=? AND source_version_id=?",
                        (state,ws,source))
        self.bump_epoch(ws)

    def delete_source(self, ws, actor, source):
        # Erasure authority is current and explicit, independent of whether old,
        # revoked, expired or unknown-time content can still be read.
        if not self.member(ws,actor,"erase") or not self.scopes_allowed(
                ws,actor,self.node_scopes(ws,source),"erase"):
            raise PermissionError("delete denied")
        if not self.db.execute("SELECT 1 FROM kg_source_state WHERE workspace_id=? "
                               "AND source_version_id=?", (ws,source)).fetchone():
            raise ValueError("source required")
        pending, doomed = [source], set()
        while pending:
            version = pending.pop()
            if version in doomed:
                continue
            doomed.add(version)
            if len(doomed) > MAX_FIXTURE_NODES:
                raise ValueError("deletion closure exceeds bound; nothing deleted")
            pending.extend(r[0] for r in self.db.execute("SELECT downstream_version_id "
                "FROM kg_dependency WHERE workspace_id=? AND upstream_version_id=? UNION "
                "SELECT assertion_version_id FROM kg_node_evidence WHERE workspace_id=? "
                "AND source_version_id=?", (ws,version,ws,version)))
        doomed_edges = set()
        for edge in self.db.execute("SELECT * FROM kg_edge_version WHERE workspace_id=?", (ws,)):
            evidence = {r[0] for r in self.db.execute("SELECT source_version_id FROM kg_edge_evidence "
                "WHERE workspace_id=? AND edge_id=?", (ws,edge["edge_id"]))}
            if edge["from_version_id"] in doomed or edge["to_version_id"] in doomed or evidence & doomed:
                doomed_edges.add(edge["edge_id"])
        with self.db:
            for kind, ids in (("node",doomed),("edge",doomed_edges)):
                self.db.executemany("INSERT INTO kg_tombstone VALUES (?,?,?,?)",
                                    [(ws,kind,x,self.known_at) for x in sorted(ids)])
            for edge in doomed_edges:
                self.db.execute("DELETE FROM kg_edge_version WHERE workspace_id=? AND edge_id=?", (ws,edge))
            for version in doomed:
                self.db.execute("DELETE FROM kg_fts WHERE workspace_id=? AND version_id=?", (ws,version))
                self.db.execute("DELETE FROM kg_node_version WHERE workspace_id=? AND version_id=?", (ws,version))
            self.bump_epoch(ws)
        self.cache = {key:value for key,value in self.cache.items() if key[0] != ws}
        # A source eraser need not be entitled to read all derived records.
        # Do not disclose descendant identifiers or counts in this response.
        return {"status":"completed","source_version_id":source}

    def handoff_join(self, ws, subject, task):
        rows = self.db.execute("SELECT a.edge_id AS first,b.edge_id AS second,b.to_version_id AS target "
            "FROM kg_edge_version a JOIN kg_edge_version b "
            "ON a.workspace_id=b.workspace_id AND a.to_version_id=b.from_version_id "
            "WHERE a.workspace_id=? AND a.from_version_id=? AND a.relation='has_bundle' "
            "AND b.relation='includes' ORDER BY target", (ws,task))
        result=[]
        for row in rows:
            edges = [self.db.execute("SELECT * FROM kg_edge_version WHERE workspace_id=? AND edge_id=?",
                                    (ws,row[key])).fetchone() for key in ("first","second")]
            if all(self.edge_allowed(ws,subject,edge) for edge in edges):
                result.append(row["target"])
        return result


CASES = []
def case(name):
    def decorate(fn):
        CASES.append((name,fn))
        return fn
    return decorate


@case("tenant_ids_and_membership_are_isolated")
def _(r):
    assert r.node_allowed("alpha","reader","project-v1")
    assert r.node_allowed("beta","beta-owner","project-v1")
    assert not r.node_allowed("beta","reader","project-v1")
    titles = [r.db.execute("SELECT title FROM kg_node_version WHERE workspace_id=? AND version_id=?",
                          (ws,"project-v1")).fetchone()[0] for ws in ("alpha","beta")]
    assert titles == ["Alpha demo","Beta demo"]


@case("public_team_membership_does_not_grant_private_access")
def _(r):
    assert r.db.execute("SELECT 1 FROM kg_public_team_member WHERE subject_id='outsider'").fetchone()
    assert not r.node_allowed("alpha","outsider","project-v1")
    assert r.export("alpha","outsider",["ctx-a"],r.snapshot("alpha"))["status"] == "not_available"


@case("composite_foreign_key_rejects_cross_workspace_reference")
def _(r):
    expect_error(sqlite3.IntegrityError, lambda:r.db.execute(
        "INSERT INTO kg_node_scope VALUES (?,?,?)",("alpha","beta-only","project:demo")))
    assert not r.db.execute("PRAGMA foreign_key_check").fetchall()


@case("typed_edges_and_immutable_versions_are_enforced")
def _(r):
    invalid = {"workspace_id":"alpha","edge_id":"bad-type","relation":"includes",
        "from_version_id":"project-v1","to_version_id":"ctx-a","scopes":["project:demo"],
        "source_version_ids":["src-topology"]}
    expect_error(sqlite3.IntegrityError,lambda:r.insert_edge(invalid))
    expect_error(sqlite3.IntegrityError,lambda:r.db.execute(
        "UPDATE kg_node_version SET title='changed' WHERE workspace_id='alpha' AND version_id='ctx-a'"))


@case("seed_authorization_and_empty_scope_fail_closed")
def _(r):
    a=r.traverse("alpha","reader","ctx-hidden")
    b=r.traverse("alpha","reader","missing")
    assert a == b == {"status":"not_available","nodes":[],"edges":[],"paths":{}}
    assert not r.node_allowed("alpha","reviewer","ctx-no-scope")


@case("hidden_middle_node_cannot_bridge_visible_destination")
def _(r):
    assert r.node_allowed("alpha","reader","ctx-visible-end")
    result=r.traverse("alpha","reader","project-v1",max_nodes=100,max_edges=150)
    assert "ctx-hidden" not in result["nodes"] and "ctx-visible-end" not in result["nodes"]
    assert all("ctx-hidden" not in path for path in result["paths"].values())


@case("hidden_required_source_blocks_assertion")
def _(r):
    assert not r.node_allowed("alpha","reader","ctx-hidden-evidence")
    assert r.node_allowed("alpha","reviewer","ctx-hidden-evidence")
    assert r.export("alpha","reader",["ctx-hidden-evidence"],r.snapshot("alpha"))["versions"] == []
    r.db.execute("INSERT INTO kg_dependency VALUES (?,?,?)",("alpha","src-private","src-a"))
    assert not r.node_allowed("alpha","reader","src-a")
    assert r.node_allowed("alpha","reviewer","src-a")
    assert r.export("alpha","reader",["src-a"],r.snapshot("alpha"))["versions"] == []


@case("every_edge_requires_authorized_scope_and_all_evidence")
def _(r):
    for version in ("ctx-edge-hidden","ctx-edge-scope","ctx-no-proof"):
        assert r.node_allowed("alpha","reader",version)
    result=r.traverse("alpha","reader","project-v1",max_nodes=100,max_edges=150)
    assert not {"ctx-edge-hidden","ctx-edge-scope","ctx-no-proof"} & set(result["nodes"])
    elevated=r.traverse("alpha","reviewer","project-v1",max_nodes=100,max_edges=150)
    assert {"ctx-edge-hidden","ctx-edge-scope"} <= set(elevated["nodes"])
    assert "ctx-no-proof" not in elevated["nodes"]


@case("required_scope_sets_are_conjunctive")
def _(r):
    sources,scopes=r.source_closure("alpha","ctx-hidden-evidence")
    assert sources == ["src-private"] and scopes == ["project:demo","restricted"]
    assert not r.node_allowed("alpha","reader","ctx-hidden-evidence")
    assert r.node_allowed("alpha","reviewer","ctx-hidden-evidence")


@case("viewer_cannot_export_even_with_export_scope")
def _(r):
    assert r.node_allowed("alpha","viewer","ctx-a")
    assert r.export("alpha","viewer",["ctx-a"],r.snapshot("alpha"))["status"] == "not_available"


@case("read_scope_is_not_export_scope")
def _(r):
    assert r.node_allowed("alpha","analyst","ctx-hidden")
    assert r.export("alpha","analyst",["ctx-hidden"],r.snapshot("alpha"))["status"] == "not_available"
    assert r.export("alpha","reader",["ctx-a"],r.snapshot("alpha"))["status"] == "ok"
    endpoints=["project-v1","ctx-edge-hidden"]
    assert r.export("alpha","reader",endpoints,r.snapshot("alpha"),["e-proof-hidden"])["status"] == "not_available"
    allowed=r.export("alpha","reviewer",endpoints,r.snapshot("alpha"),["e-proof-hidden"])
    assert allowed["status"] == "ok" and "src-private" in allowed["required_source_versions"]


@case("membership_revocation_invalidates_read_cache_and_export")
def _(r):
    result=r.traverse("alpha","reader","task-v1")
    epoch=r.snapshot("alpha")
    r.save_cache("alpha","reader","handoff",result)
    assert r.read_cache("alpha","reader","handoff")
    r.change_member("alpha","reader",active=False)
    assert not r.node_allowed("alpha","reader","ctx-a")
    assert r.read_cache("alpha","reader","handoff") is None
    assert r.export("alpha","reader",["ctx-a"],epoch)["versions"] == []


@case("role_or_grant_revocation_invalidates_preview_and_cache")
def _(r):
    result=r.traverse("alpha","reader","task-v1")
    epoch=r.snapshot("alpha")
    r.save_cache("alpha","reader","handoff",result)
    r.change_member("alpha","reader",role="viewer")
    assert r.node_allowed("alpha","reader","ctx-a")
    assert r.read_cache("alpha","reader","handoff") is None
    assert r.export("alpha","reader",["ctx-a"],epoch)["versions"] == []
    second=Reference()
    epoch=second.snapshot("alpha")
    second.save_cache("alpha","reader","handoff",second.traverse("alpha","reader","task-v1"))
    second.revoke_grant("alpha","reader","project:demo","read")
    assert not second.node_allowed("alpha","reader","ctx-a")
    assert second.read_cache("alpha","reader","handoff") is None
    assert second.export("alpha","reader",["ctx-a"],epoch)["versions"] == []
    assert second.export("alpha","reader",["ctx-a"],second.snapshot("alpha"))["versions"] == []


@case("current_source_revocation_overrides_historical_queries")
def _(r):
    r.save_cache("alpha","reader","handoff",r.traverse("alpha","reader","task-v1"))
    epoch=r.snapshot("alpha")
    r.source_state("alpha","src-a","revoked")
    assert not r.node_allowed("alpha","reader","ctx-a",valid_at="2026-11-02T00:00:00Z",
                              known_at="2026-11-02T00:00:00Z")
    assert r.read_cache("alpha","reader","handoff") is None
    assert r.export("alpha","reader",["ctx-a"],epoch)["versions"] == []


@case("valid_time_and_known_time_handle_late_correction")
def _(r):
    assert r.choose_revision("alpha","reader","decision-1","2026-11-07T00:00:00Z",
                             "2026-11-08T00:00:00Z") == "ctx-old"
    assert r.choose_revision("alpha","reader","decision-1","2026-11-07T00:00:00Z",
                             "2026-11-18T00:00:00Z") == "ctx-new"
    assert r.choose_revision("alpha","reader","decision-1","2026-11-03T00:00:00Z",
                             "2026-11-18T00:00:00Z") == "ctx-history"


@case("source_replay_is_idempotent_and_payload_conflict_rejected")
def _(r):
    item=next(x for x in r.fixture["nodes"] if x["version_id"]=="src-a")
    before=(r.count("kg_node_version"),r.count("kg_fts"))
    assert r.insert_node(item) is False
    assert before == (r.count("kg_node_version"),r.count("kg_fts"))
    expect_error(ValueError,lambda:r.insert_node({**item,"body":"Different payload"}))
    r.source_state("alpha","src-a","revoked")
    assert r.insert_node(item) is False
    assert not r.node_allowed("alpha","reader","ctx-a")


@case("cycles_terminate_and_depth_limit_is_reported")
def _(r):
    result=r.traverse("alpha","reader","ctx-cycle-a")
    assert result["nodes"] == ["ctx-cycle-a","ctx-cycle-b"]
    assert len(result["edges"]) == 2 and len(set(result["edges"])) == 2
    bounded=r.traverse("alpha","reader","ctx-cycle-a",max_depth=1)
    assert bounded["truncated"] and "depth" in bounded["truncation_reasons"]
    r.db.execute("INSERT INTO kg_dependency VALUES (?,?,?)",("alpha","ctx-cycle-a","ctx-cycle-b"))
    r.db.execute("INSERT INTO kg_dependency VALUES (?,?,?)",("alpha","ctx-cycle-b","ctx-cycle-a"))
    assert not r.node_allowed("alpha","reader","ctx-cycle-a")


@case("fanout_result_and_execution_budgets_are_enforced")
def _(r):
    result=r.traverse("alpha","reader","project-v1",max_nodes=5,max_edges=5)
    assert result["status"]=="ok" and len(result["nodes"])<=5 and len(result["edges"])<=5
    assert result["truncated"]
    interrupted=r.traverse("alpha","reader","project-v1",max_vm_steps=1)
    assert interrupted == {"status":"budget_exhausted","nodes":[],"edges":[],"paths":{}}


@case("unknown_valid_time_is_explicit_and_not_exported")
def _(r):
    assert not r.node_allowed("alpha","reader","ctx-unknown")
    assert r.node_allowed("alpha","reader","ctx-unknown",allow_unknown=True)
    assert not r.node_allowed("alpha","reader","ctx-unknown","export",allow_unknown=True)


@case("source_deletion_removes_dependency_closure_fts_and_cache")
def _(r):
    r.save_cache("alpha","reader","handoff",r.traverse("alpha","reader","task-v1"))
    receipt=r.delete_source("alpha","reviewer","src-a")
    assert receipt == {"status":"completed","source_version_id":"src-a"}
    removed=[x[0] for x in r.db.execute("SELECT resource_id FROM kg_tombstone "
             "WHERE workspace_id='alpha' AND resource_kind='node'")]
    assert {"src-a","ctx-a","ctx-combined","bundle-v1"} <= set(removed)
    assert r.read_cache("alpha","reader","handoff") is None
    for version in removed:
        assert not r.db.execute("SELECT 1 FROM kg_fts WHERE workspace_id=? AND version_id=?",
                                ("alpha",version)).fetchone()
        assert not r.node_allowed("alpha","reader",version,valid_at="2026-11-02T00:00:00Z",
                                  known_at="2026-11-02T00:00:00Z")
    item=next(x for x in r.fixture["nodes"] if x["version_id"]=="src-a")
    expect_error(ValueError,lambda:r.insert_node(item))
    assert not r.db.execute("PRAGMA foreign_key_check").fetchall()
    revoked=Reference()
    revoked.source_state("alpha","src-a","revoked")
    revoked.revoke_grant("alpha","reviewer","project:demo","read")
    assert revoked.delete_source("alpha","reviewer","src-a")=={"status":"completed","source_version_id":"src-a"}
    assert not revoked.db.execute("SELECT 1 FROM kg_node_version WHERE workspace_id='alpha' AND version_id='src-a'").fetchone()
    unknown=Reference()
    unknown.insert_node({"workspace_id":"alpha","version_id":"src-unknown-time",
        "logical_id":"src-unknown-time","kind":"SourceRevision","title":"Unknown time source",
        "body":"Synthetic unknown-time evidence.","scopes":["project:demo"],
        "source_state":"revoked","valid_from":None})
    expect_error(PermissionError,lambda:unknown.delete_source("alpha","reader","src-unknown-time"))
    assert unknown.delete_source("alpha","reviewer","src-unknown-time")["status"]=="completed"
    assert not unknown.db.execute("SELECT 1 FROM kg_node_version WHERE workspace_id='alpha' AND version_id='src-unknown-time'").fetchone()


@case("all_required_synthesis_dies_but_independent_assertion_survives")
def _(r):
    r.delete_source("alpha","reviewer","src-a")
    assert not r.node_allowed("alpha","reader","ctx-combined")
    assert r.node_allowed("alpha","reader","src-b")
    assert r.node_allowed("alpha","reader","ctx-independent")


@case("injection_text_and_query_are_inert_data")
def _(r):
    before=r.count("kg_node_version")
    assert r.node_allowed("alpha","reader","ctx-inert")
    assert any(x["version_id"]=="ctx-inert" for x in r.search("alpha","reader","DROP TABLE"))
    r.search("alpha","reader","'); DROP TABLE kg_node_version;--")
    assert r.count("kg_node_version")==before
    assert "subprocess" not in globals() and "requests" not in globals()


@case("constructed_handoff_matches_fixed_relational_join")
def _(r):
    required={"ctx-a","ctx-b","ctx-combined"}
    lexical={x["version_id"] for x in r.search("alpha","reader","handoff")}
    graph=r.traverse("alpha","reader","task-v1")
    joined=set(r.handoff_join("alpha","reader","task-v1"))
    assert not required & lexical
    assert required <= set(graph["nodes"]) and joined==required


@case("stale_source_is_readable_but_not_exportable")
def _(r):
    assert r.node_allowed("alpha","reader","ctx-stale")
    assert r.export("alpha","reader",["ctx-stale"],r.snapshot("alpha"))["status"]=="not_available"
    sources,_=r.source_closure("alpha","ctx-stale")
    assert sources==["src-stale"]


@case("hidden_fts_matches_do_not_change_visible_ranking_or_count")
def _(r):
    before=r.search("alpha","reader","handoff")
    old_snapshot=r.snapshot("alpha")
    r.save_cache("alpha","reader","handoff",r.traverse("alpha","reader","task-v1"))
    r.insert_node({"workspace_id":"alpha","version_id":"hidden-match","logical_id":"hidden-match",
        "kind":"ContextItem","title":"Handoff "*40,"body":"handoff "*500,
        "scopes":["project:demo","restricted"]})
    r.db.execute("INSERT INTO kg_node_evidence VALUES (?,?,?)",
                 ("alpha","hidden-match","src-private"))
    assert r.search("alpha","reader","handoff")==before
    assert r.read_cache("alpha","reader","handoff") is None
    assert r.export("alpha","reader",["ctx-a"],old_snapshot)["status"]=="stale_preview"


def query_examples():
    r=Reference()
    examples=[]
    for query in r.fixture["constructed_queries"]:
        start=time.perf_counter()
        lexical=r.search("alpha","reader",query["query"])
        lexical_ms=(time.perf_counter()-start)*1000
        start=time.perf_counter()
        graph=r.traverse("alpha","reader",query["seed"])
        graph_ms=(time.perf_counter()-start)*1000
        required=set(query["required_context_ids"])
        example={
            "id":query["id"],"description":query["description"],
            "lexical_match_ids":[x["version_id"] for x in lexical],
            "graph_context_ids":[x for x in graph["nodes"] if x.startswith("ctx-")],
            "graph_source_ids":[x for x in graph["nodes"] if x.startswith("src-")],
            "required_context_ids":sorted(required),
            "lexical_required_found":len(required & {x["version_id"] for x in lexical}),
            "graph_required_found":len(required & set(graph["nodes"])),
            "paths":graph["paths"],"truncated":graph["truncated"],
            "required_node_evidence":graph.get("required_node_evidence",{}),
            "required_edge_evidence":graph.get("required_edge_evidence",{}),
            "single_run_ms":{"lexical":round(lexical_ms,4),"graph":round(graph_ms,4)}
        }
        if query["id"]=="Q1":
            example["fixed_relational_join_ids"]=r.handoff_join("alpha","reader",query["seed"])
        examples.append(example)
    return examples


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,default=ROOT/"results.json")
    args=parser.parse_args()
    results=[]
    started=time.perf_counter()
    for name,fn in CASES:
        r=Reference()
        tick=time.perf_counter()
        try:
            fn(r)
            results.append({"case":name,"passed":True,"elapsed_ms":round((time.perf_counter()-tick)*1000,4)})
        except Exception as error:
            results.append({"case":name,"passed":False,"error":f"{type(error).__name__}: {error}"})
        finally:
            r.db.close()
    sample=Reference()
    counts={name:sample.count(name) for name in ("kg_node_version","kg_edge_version","kg_fts")}
    report={
        "status":"passed" if all(x["passed"] for x in results) else "failed",
        "classification":"SYNTHETIC REFERENCE EXPERIMENT; not Token Horizon implementation or product validation",
        "generated_at_utc":dt.datetime.now(dt.timezone.utc).isoformat(),
        "source_baseline_for_research":"Token Horizon main b468206e9378c8d7a6788b67072494982e7de17d; not imported or executed",
        "runtime":{"python":platform.python_version(),"sqlite":sqlite3.sqlite_version,
                   "platform":platform.system(),"database":":memory:","fts5":True},
        "input_sha256":{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
                         for name in ("schema.sql","fixture.json","validate.py")},
        "fixture_counts":counts,"tests_passed":sum(x["passed"] for x in results),
        "tests_total":len(results),"tests":results,
        "constructed_query_examples":query_examples(),
        "elapsed_seconds_including_fixture_setup":round(time.perf_counter()-started,4),
        "limits":[
            "All data are synthetic. Fixture cases are deliberately constructed, not a representative benchmark.",
            "Subjects are trusted function arguments; no authentication server or transport is implemented.",
            "Times are single-process toy measurements; no p95, concurrency, disk, network or production-size result is claimed.",
            "No bm25/global corpus scores, hidden match counts, autocomplete or facets are exposed.",
            "Search is toy ASCII tokenization and OR matching, not multilingual or phrase retrieval.",
            "Inert text checks SQL/data handling here, not an LLM's prompt-injection resistance.",
            "Cache labels stand for trusted canonical query keys; no public cache API is implemented.",
            "Logical row/FTS/cache removal and tombstone no-resurrection are tested; physical disk, backup and downstream-copy erasure are not.",
            "Current ACL/lifecycle override historical reads; this is not historical access permission replay.",
            "The fixture inserts preclosed bitemporal intervals; an atomic production correction writer is not implemented.",
            "SQL statement interruption bounds this traversal; timing-constant noninterference is not established.",
            "No paid calls, installs, network, Token Horizon imports, app mutations or shared repository edits."
        ]
    }
    args.output.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({"status":report["status"],"passed":report["tests_passed"],
                      "total":len(results),"fixture_counts":counts,
                      "elapsed_seconds":report["elapsed_seconds_including_fixture_setup"],
                      "output":str(args.output)},indent=2))
    for test in results:
        if not test["passed"]:
            print(json.dumps(test))
    raise SystemExit(0 if report["status"]=="passed" else 1)


if __name__=="__main__":
    main()

