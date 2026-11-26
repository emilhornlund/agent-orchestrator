#!/bin/sh
set -eu

node --input-type=module <<'JS'
import fs from 'node:fs';
import { loadConfig } from './dist/config/config.js';
import { provisionCoordinationNamespace } from './dist/coordination/project-ownership.js';

const { coordinationRoot, coordinationNamespaceId } = loadConfig().workflow;
if (coordinationRoot === '/var/lib/agent-orchestrator/coordination' && fs.readdirSync(coordinationRoot).length === 0) {
  fs.chmodSync(coordinationRoot, 0o700);
  provisionCoordinationNamespace(coordinationRoot, coordinationNamespaceId);
}
JS

exec "$@"
