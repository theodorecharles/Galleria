import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Request } from 'express';

const dataDir = mkdtempSync(path.join(tmpdir(), 'galleria-album-access-'));
process.env.DATA_DIR = dataDir;

let albumAccess: typeof import('./album-access.js');
let shareKey = '';
let expiredShareKey = '';

function request(options: { authenticated?: boolean; key?: string } = {}): Request {
  return {
    isAuthenticated: () => Boolean(options.authenticated),
    session: options.authenticated ? { userId: 1 } : {},
    query: options.key ? { key: options.key } : {},
  } as unknown as Request;
}

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test.before(async () => {
  const database = await import('../database.js');
  albumAccess = await import('./album-access.js');

  database.initializeDatabase();
  database.saveAlbum('Published', true);
  database.saveAlbum('Private', false);
  database.saveAlbum('OtherPrivate', false);
  shareKey = database.createShareLink('Private', null).secret_key;
  expiredShareKey = database.createShareLink('Private', new Date(Date.now() - 60_000).toISOString()).secret_key;
});

test('allows public access to published albums', () => {
  const access = albumAccess.getAlbumAccess(request(), 'Published');

  assert.equal(access.allowed, true);
  assert.equal(access.reason, 'published');
});

test('denies anonymous access to unpublished albums without a valid share link', () => {
  const access = albumAccess.getAlbumAccess(request(), 'Private');

  assert.equal(access.allowed, false);
  assert.equal(access.exists, true);
  assert.equal(access.reason, 'denied');
});

test('allows authenticated access to unpublished albums', () => {
  const access = albumAccess.getAlbumAccess(request({ authenticated: true }), 'Private');

  assert.equal(access.allowed, true);
  assert.equal(access.reason, 'authenticated');
});

test('allows share-link access only for the matching unexpired album', () => {
  const allowed = albumAccess.getAlbumAccess(request({ key: shareKey }), 'Private');
  const wrongAlbum = albumAccess.getAlbumAccess(request({ key: shareKey }), 'OtherPrivate');
  const expired = albumAccess.getAlbumAccess(request({ key: expiredShareKey }), 'Private');

  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'share_link');
  assert.equal(wrongAlbum.allowed, false);
  assert.equal(wrongAlbum.reason, 'denied');
  assert.equal(expired.allowed, false);
  assert.equal(expired.reason, 'denied');
});
