-- PROPOSAL / SYNTHETIC REFERENCE ONLY. Not a Token Horizon migration.
PRAGMA foreign_keys = ON;

CREATE TABLE kg_workspace (
  workspace_id TEXT PRIMARY KEY,
  policy_epoch INTEGER NOT NULL DEFAULT 1 CHECK (policy_epoch > 0),
  graph_revision INTEGER NOT NULL DEFAULT 1 CHECK (graph_revision > 0)
);
CREATE TABLE kg_member (
  workspace_id TEXT NOT NULL, subject_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  PRIMARY KEY (workspace_id, subject_id),
  FOREIGN KEY (workspace_id) REFERENCES kg_workspace(workspace_id)
);
CREATE TABLE kg_grant (
  workspace_id TEXT NOT NULL, subject_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read','export','erase')),
  PRIMARY KEY (workspace_id, subject_id, scope_id, permission),
  FOREIGN KEY (workspace_id, subject_id)
    REFERENCES kg_member(workspace_id, subject_id) ON DELETE CASCADE
);
-- Public membership deliberately has no corresponding private-membership grant.
CREATE TABLE kg_public_team_member (
  workspace_id TEXT NOT NULL, team_id TEXT NOT NULL, subject_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, team_id, subject_id),
  FOREIGN KEY (workspace_id) REFERENCES kg_workspace(workspace_id)
);
CREATE TABLE kg_node_version (
  workspace_id TEXT NOT NULL, version_id TEXT NOT NULL, logical_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('Project','Task','Bundle','ContextItem','SourceRevision','Session','Attempt')),
  title TEXT NOT NULL, body TEXT NOT NULL,
  valid_from TEXT, valid_to TEXT,
  recorded_from TEXT NOT NULL, recorded_to TEXT,
  PRIMARY KEY (workspace_id, version_id),
  FOREIGN KEY (workspace_id) REFERENCES kg_workspace(workspace_id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  CHECK (recorded_to IS NULL OR recorded_to > recorded_from)
);
CREATE INDEX kg_node_logical ON kg_node_version
  (workspace_id, logical_id, recorded_from, recorded_to, valid_from, valid_to);
-- Corrections insert new version IDs. This fixture inserts closed intervals up
-- front; it contains no production API for closing an open recorded interval.
CREATE TRIGGER kg_node_immutable BEFORE UPDATE ON kg_node_version
BEGIN SELECT RAISE(ABORT, 'immutable node version'); END;
CREATE TABLE kg_node_scope (
  workspace_id TEXT NOT NULL, version_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, version_id, scope_id),
  FOREIGN KEY (workspace_id, version_id)
    REFERENCES kg_node_version(workspace_id, version_id) ON DELETE CASCADE
);
CREATE TABLE kg_source_state (
  workspace_id TEXT NOT NULL, source_version_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','stale','revoked')),
  PRIMARY KEY (workspace_id, source_version_id),
  FOREIGN KEY (workspace_id, source_version_id)
    REFERENCES kg_node_version(workspace_id, version_id) ON DELETE CASCADE
);
CREATE TRIGGER kg_source_kind BEFORE INSERT ON kg_source_state
WHEN NOT EXISTS (SELECT 1 FROM kg_node_version n
  WHERE n.workspace_id=NEW.workspace_id AND n.version_id=NEW.source_version_id
  AND n.kind='SourceRevision')
BEGIN SELECT RAISE(ABORT, 'source kind required'); END;
CREATE TABLE kg_node_evidence (
  workspace_id TEXT NOT NULL, assertion_version_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, assertion_version_id, source_version_id),
  FOREIGN KEY (workspace_id, assertion_version_id)
    REFERENCES kg_node_version(workspace_id, version_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_version_id)
    REFERENCES kg_source_state(workspace_id, source_version_id) ON DELETE CASCADE
);
-- Every evidence row is REQUIRED, not a bag of interchangeable alternatives.
-- Independent claims must use separate assertion versions.
CREATE TABLE kg_dependency (
  workspace_id TEXT NOT NULL, upstream_version_id TEXT NOT NULL,
  downstream_version_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, upstream_version_id, downstream_version_id),
  FOREIGN KEY (workspace_id, upstream_version_id)
    REFERENCES kg_node_version(workspace_id, version_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, downstream_version_id)
    REFERENCES kg_node_version(workspace_id, version_id) ON DELETE CASCADE
);
CREATE TRIGGER kg_evidence_dependency AFTER INSERT ON kg_node_evidence
BEGIN
  INSERT OR IGNORE INTO kg_dependency VALUES
    (NEW.workspace_id, NEW.source_version_id, NEW.assertion_version_id);
END;
CREATE TABLE kg_edge_version (
  workspace_id TEXT NOT NULL, edge_id TEXT NOT NULL, relation TEXT NOT NULL,
  from_version_id TEXT NOT NULL, to_version_id TEXT NOT NULL,
  valid_from TEXT, valid_to TEXT,
  recorded_from TEXT NOT NULL, recorded_to TEXT,
  PRIMARY KEY (workspace_id, edge_id),
  FOREIGN KEY (workspace_id, from_version_id)
    REFERENCES kg_node_version(workspace_id, version_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, to_version_id)
    REFERENCES kg_node_version(workspace_id, version_id) ON DELETE CASCADE,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  CHECK (recorded_to IS NULL OR recorded_to > recorded_from)
);
CREATE INDEX kg_edges_out ON kg_edge_version(workspace_id, from_version_id, edge_id);
CREATE INDEX kg_edges_in ON kg_edge_version(workspace_id, to_version_id);
CREATE TRIGGER kg_edge_immutable BEFORE UPDATE ON kg_edge_version
BEGIN SELECT RAISE(ABORT, 'immutable edge version'); END;
CREATE TRIGGER kg_edge_type BEFORE INSERT ON kg_edge_version
WHEN NOT EXISTS (
  SELECT 1 FROM kg_node_version a JOIN kg_node_version b
    ON a.workspace_id=b.workspace_id
  WHERE a.workspace_id=NEW.workspace_id
    AND a.version_id=NEW.from_version_id AND b.version_id=NEW.to_version_id
    AND (
      (NEW.relation='contains' AND a.kind='Project' AND b.kind='Task') OR
      (NEW.relation='has_bundle' AND a.kind='Task' AND b.kind='Bundle') OR
      (NEW.relation='includes' AND a.kind='Bundle' AND b.kind='ContextItem') OR
      (NEW.relation='context' AND a.kind='Project' AND b.kind='ContextItem') OR
      (NEW.relation='relates_to' AND a.kind='ContextItem' AND b.kind='ContextItem') OR
      (NEW.relation='cites' AND a.kind='ContextItem' AND b.kind='SourceRevision') OR
      (NEW.relation='works_on' AND a.kind='Session' AND b.kind='Project') OR
      (NEW.relation='contains' AND a.kind='Session' AND b.kind='Attempt') OR
      (NEW.relation='observed' AND a.kind='Attempt' AND b.kind='ContextItem')
    )
)
BEGIN SELECT RAISE(ABORT, 'invalid typed edge'); END;
CREATE TABLE kg_edge_scope (
  workspace_id TEXT NOT NULL, edge_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, edge_id, scope_id),
  FOREIGN KEY (workspace_id, edge_id)
    REFERENCES kg_edge_version(workspace_id, edge_id) ON DELETE CASCADE
);
CREATE TABLE kg_edge_evidence (
  workspace_id TEXT NOT NULL, edge_id TEXT NOT NULL, source_version_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, edge_id, source_version_id),
  FOREIGN KEY (workspace_id, edge_id)
    REFERENCES kg_edge_version(workspace_id, edge_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_version_id)
    REFERENCES kg_source_state(workspace_id, source_version_id) ON DELETE CASCADE
);
-- Tombstones intentionally survive physical removal of the referenced row.
-- Their only FK is the workspace; live-row FKs would prevent erasure.
CREATE TABLE kg_tombstone (
  workspace_id TEXT NOT NULL, resource_kind TEXT NOT NULL
    CHECK (resource_kind IN ('node','edge')),
  resource_id TEXT NOT NULL, deleted_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, resource_kind, resource_id),
  FOREIGN KEY (workspace_id) REFERENCES kg_workspace(workspace_id)
);
-- FTS is a derived non-authoritative index. SQLite virtual tables cannot have
-- these composite PK/FKs. Every hit MUST rejoin/check kg_node_version + ACL.
CREATE VIRTUAL TABLE kg_fts USING fts5
  (workspace_id UNINDEXED, version_id UNINDEXED, title, body);


-- Projection changes invalidate complete/negative caches and export previews.
-- These explicit triggers also cover evidence, scope and lifecycle changes.
CREATE TRIGGER kg_node_version_revision_insert AFTER INSERT ON kg_node_version
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_node_version_revision_delete AFTER DELETE ON kg_node_version
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=OLD.workspace_id; END;
CREATE TRIGGER kg_edge_version_revision_insert AFTER INSERT ON kg_edge_version
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_edge_version_revision_delete AFTER DELETE ON kg_edge_version
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=OLD.workspace_id; END;
CREATE TRIGGER kg_node_scope_revision_insert AFTER INSERT ON kg_node_scope
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_node_scope_revision_update AFTER UPDATE ON kg_node_scope
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_node_scope_revision_delete AFTER DELETE ON kg_node_scope
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=OLD.workspace_id; END;
CREATE TRIGGER kg_edge_scope_revision_insert AFTER INSERT ON kg_edge_scope
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_edge_scope_revision_update AFTER UPDATE ON kg_edge_scope
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_edge_scope_revision_delete AFTER DELETE ON kg_edge_scope
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=OLD.workspace_id; END;
CREATE TRIGGER kg_source_state_revision_insert AFTER INSERT ON kg_source_state
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_source_state_revision_update AFTER UPDATE ON kg_source_state
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_source_state_revision_delete AFTER DELETE ON kg_source_state
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=OLD.workspace_id; END;
CREATE TRIGGER kg_node_evidence_revision_insert AFTER INSERT ON kg_node_evidence
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_node_evidence_revision_update AFTER UPDATE ON kg_node_evidence
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_node_evidence_revision_delete AFTER DELETE ON kg_node_evidence
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=OLD.workspace_id; END;
CREATE TRIGGER kg_edge_evidence_revision_insert AFTER INSERT ON kg_edge_evidence
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_edge_evidence_revision_update AFTER UPDATE ON kg_edge_evidence
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_edge_evidence_revision_delete AFTER DELETE ON kg_edge_evidence
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=OLD.workspace_id; END;
CREATE TRIGGER kg_dependency_revision_insert AFTER INSERT ON kg_dependency
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_dependency_revision_update AFTER UPDATE ON kg_dependency
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_dependency_revision_delete AFTER DELETE ON kg_dependency
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=OLD.workspace_id; END;
CREATE TRIGGER kg_tombstone_revision_insert AFTER INSERT ON kg_tombstone
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_tombstone_revision_update AFTER UPDATE ON kg_tombstone
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER kg_tombstone_revision_delete AFTER DELETE ON kg_tombstone
BEGIN UPDATE kg_workspace SET graph_revision=graph_revision+1 WHERE workspace_id=OLD.workspace_id; END;
