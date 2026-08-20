import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const input = resolve(process.argv[2] || 'vehicles.csv');
const output = resolve(process.argv[3] || 'assets/vehicle-data.js');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCsv(await readFile(input, 'utf8'));
const headers = rows.shift();
const yearIndex = headers.indexOf('year');
const makeIndex = headers.indexOf('make');
const modelIndex = headers.indexOf('model');
const baseModelIndex = headers.indexOf('baseModel');

if ([yearIndex, makeIndex, modelIndex].includes(-1)) {
  throw new Error('The source CSV is missing year, make, or model columns.');
}

const vehicleSets = new Map();
for (const row of rows) {
  const year = row[yearIndex]?.trim();
  let make = row[makeIndex]?.trim();
  const model = (row[baseModelIndex]?.trim() || row[modelIndex]?.trim());
  if (!/^\d{4}$/.test(year) || !make || !model) continue;
  if (make.toLowerCase() === 'ram') make = 'Dodge';
  if (/^roush\b/i.test(make)) make = 'Ford';
  if (!vehicleSets.has(year)) vehicleSets.set(year, new Map());
  const makes = vehicleSets.get(year);
  if (!makes.has(make)) makes.set(make, new Set());
  makes.get(make).add(model);
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const vehicles = {};
for (const year of [...vehicleSets.keys()].sort((a, b) => Number(b) - Number(a))) {
  vehicles[year] = {};
  const makes = vehicleSets.get(year);
  for (const make of [...makes.keys()].sort(collator.compare)) {
    vehicles[year][make] = [...makes.get(make)].sort(collator.compare);
  }
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `/* Generated from the FuelEconomy.gov vehicle dataset. Do not edit by hand. */\nwindow.TD_VEHICLES=${JSON.stringify(vehicles)};\n`);
console.log(`Wrote ${Object.keys(vehicles).length} model years to ${output}`);
