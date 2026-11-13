#!/usr/bin/env node
'use strict';
// Compiles config/*.yaml (the spec) into plugin/defaults/*.json (what the hooks load) — D40.
// Also copies the .engos templates into the plugin. Run after changing config/ or templates/.

const fs = require('fs');
const path = require('path');
const yaml = require('../plugin/scripts/vendor/js-yaml.min.js');

const repo = path.resolve(__dirname, '..');
const outDir = path.join(repo, 'plugin', 'defaults');
fs.mkdirSync(outDir, { recursive: true });

for (const name of ['rules', 'policies', 'agents', 'recommendations']) {
  const src = path.join(repo, 'config', name + '.yaml');
  const data = yaml.load(fs.readFileSync(src, 'utf8'));
  fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('built plugin/defaults/' + name + '.json');
}

const tplOut = path.join(repo, 'plugin', 'templates');
fs.mkdirSync(tplOut, { recursive: true });
for (const f of ['BRIEF.md', 'STATE.yaml']) {
  fs.copyFileSync(path.join(repo, 'templates', 'engos', f), path.join(tplOut, f));
  console.log('copied plugin/templates/' + f);
}
