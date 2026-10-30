#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { compare } from './compare.mjs';

try {
  const args = process.argv.slice(2), json = args.includes('--json');
  const files = args.filter(arg => arg !== '--json');
  if (files.length !== 2 || args.some(arg => arg.startsWith('--') && arg !== '--json')) throw new Error('Usage: node src/cli.mjs BEFORE.json AFTER.json [--json]');
  const report = compare(...files.map(file => JSON.parse(readFileSync(file, 'utf8'))));
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`ContractLens: ${report.breaking} breaking changes; ${report.review} manual reviews`);
    for (const finding of report.findings) console.log(`${finding.severity.toUpperCase()} ${finding.code} ${finding.path}: ${finding.message}`);
    if (!report.findings.length) console.log('No incompatible changes detected in the supported subset.');
  }
  process.exitCode = report.review ? 2 : report.breaking ? 1 : 0;
} catch (error) {
  console.error('ContractLens: ' + error.message);
  process.exitCode = 2;
}
