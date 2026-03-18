#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const registerPath = path.join(__dirname, '..', 'docs', 'risk-register.md');
const source = fs.readFileSync(registerPath, 'utf8');

const lines = source.split(/\r?\n/);
const tableLines = [];
let inTable = false;

for (const line of lines) {
  if (!inTable) {
    if (line.trim().startsWith('| ID |')) {
      inTable = true;
      tableLines.push(line);
    }
    continue;
  }

  if (!line.trim().startsWith('|')) break;
  tableLines.push(line);
}

if (tableLines.length < 3) {
  console.error('Risk register table not found or incomplete.');
  process.exit(1);
}

function splitRow(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

const headers = splitRow(tableLines[0]);
const expectedHeaders = [
  'ID',
  'Area',
  'Severity',
  'Finding',
  'Exploit Path',
  'Status',
  'Owner',
  'Required Test',
  'Fix PR',
  'Accepted Until',
  'Last Reviewed',
];

for (const header of expectedHeaders) {
  if (!headers.includes(header)) {
    console.error(`Risk register missing required column: ${header}`);
    process.exit(1);
  }
}

const rows = tableLines.slice(2).map((line) => {
  const values = splitRow(line);
  const row = {};
  headers.forEach((header, index) => {
    row[header] = values[index] || '';
  });
  return row;
});

const now = Date.now();
const blockingRows = [];

for (const row of rows) {
  const severity = row['Severity'];
  if (!['Critical', 'High'].includes(severity)) continue;

  const status = row['Status'];
  if (status === 'Resolved') continue;

  if (status === 'Accepted') {
    const acceptedUntil = Date.parse(row['Accepted Until']);
    if (Number.isFinite(acceptedUntil) && acceptedUntil > now) continue;
  }

  blockingRows.push(row);
}

if (blockingRows.length > 0) {
  console.error('Blocking High/Critical risks remain unresolved or lack a valid waiver:');
  for (const row of blockingRows) {
    console.error(`- ${row.ID}: ${row.Finding} [${row.Status}]`);
  }
  process.exit(1);
}

console.log(`Risk register check passed for ${rows.length} entries.`);
