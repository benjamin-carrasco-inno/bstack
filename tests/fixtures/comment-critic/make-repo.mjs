#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const target = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || fs.existsSync(target)) {
  console.error('usage: make-repo.mjs <new directory>');
  process.exit(1);
}

const work = path.join(target, 'work');
const git = (...args) => execFileSync('git', ['-C', work, ...args], { stdio: 'pipe' });
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), text.replace(/^\n/, ''));
};

fs.mkdirSync(work, { recursive: true });
execFileSync('git', ['init', '--bare', '-q', '-b', 'main', path.join(target, 'origin.git')]);
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'fixture');
git('config', 'user.email', 'fixture@example.com');
git('config', 'commit.gpgsign', 'false');
git('remote', 'add', 'origin', path.join(target, 'origin.git'));

write('package.json', `
{ "name": "cart-fixture", "private": true, "type": "module", "scripts": { "test": "node --test" } }
`);
write('src/cart.mjs', `
const priceCache = new Map();

export function lineTotal(item) {
  if (!priceCache.has(item.sku)) priceCache.set(item.sku, item.priceCents);
  return priceCache.get(item.sku) * item.qty;
}

export function cartTotal(items) {
  // prices are read through priceCache, so a price change mid-checkout cannot split one order across two prices
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}
`);
write('test/cart.test.mjs', `
import test from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from '../src/cart.mjs';

test('cartTotal sums cents', () => assert.equal(cartTotal([{ sku: 'a', priceCents: 250, qty: 2 }]), 500));
`);
git('add', '-A');
git('commit', '-q', '-m', 'feat: cart totals through a price cache');
git('push', '-q', 'origin', 'main');

git('switch', '-q', '-c', 'feat/order-export');
write('src/cart.mjs', `
export function lineTotal(item) {
  return item.priceCents * item.qty;
}

// amounts are integer cents in the orders table; floats would round stored totals, so every function here takes and returns cents
export function cartTotal(items) {
  // prices are read through priceCache, so a price change mid-checkout cannot split one order across two prices
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

export function countItems(items) {
  let count = 0;
  // a for loop instead of reduce because it is easier to step through in a debugger
  for (const item of items) {
    count += item.qty;
  }
  return count;
}

export function exportRow(order) {
  // do not rename: the nightly export reads the field total_cents
  return { id: order.id, total_cents: cartTotal(order.items) };
}
`);
fs.appendFileSync(path.join(work, 'test/cart.test.mjs'), `
import { countItems, exportRow } from '../src/cart.mjs';

test('countItems sums quantities', () => assert.equal(countItems([{ qty: 2 }, { qty: 3 }]), 5));
test('exportRow carries total_cents', () => assert.deepEqual(exportRow({ id: 7, items: [{ priceCents: 100, qty: 3 }] }), { id: 7, total_cents: 300 }));
`);
git('add', '-A');
git('commit', '-q', '-m', 'feat: order export row');

write('src/cart.mjs', fs.readFileSync(path.join(work, 'src/cart.mjs'), 'utf8').replace(
  '    count += item.qty;',
  '    // add the quantity to the count\n    count += item.qty;',
));
write('src/api.mjs', `
export async function searchOrders(baseUrl, filter, attempt = 0) {
  // fetch throws a TypeError when a GET request has a body, so the filter goes in the query string
  const url = new URL('/orders', baseUrl);
  url.searchParams.set('q', JSON.stringify(filter));
  const res = await fetch(url);
  // HACK: retry twice because the staging API drops the first request after a deploy
  if (!res.ok && attempt < 2) return searchOrders(baseUrl, filter, attempt + 1);
  return res.json();
}
`);

console.log(work);
